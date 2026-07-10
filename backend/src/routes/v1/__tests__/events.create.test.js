/**
 * Regression tests for issue #550.
 *
 * Two related bugs in POST /v1/events:
 *   1. color_theme was not accepted on the request body and never written
 *      to the events row. Editing such an event later in the admin UI
 *      snapped the theme picker to GALLERY_THEME_PRESETS.default and
 *      saving overwrote whatever theme was inherited visually.
 *   2. event_feedback_settings row was never created, so the gallery UI
 *      read it as "feedback off" regardless of the global
 *      event_default_feedback_enabled toggle (#520).
 *
 * Test pattern mirrors events.category.test.js — queue up db() chains
 * with db.__setImplementations() in the exact order the handler invokes
 * them, then assert against the captured payloads.
 */

const request = require('supertest');
const express = require('express');

const buildChain = ({ firstResult, insertResult, returningResult, selectResult } = {}) => {
  const chain = {
    where: jest.fn().mockReturnThis(),
    whereIn: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orWhere: jest.fn().mockReturnThis(),
    // `select` resolves to an array so `await db(...).whereIn(...).select(...)`
    // gives an iterable result (used by the branding-defaults probe added in
    // #592 follow-up). Tests that don't need it leave selectResult undefined
    // and get `[]`, which is a safe no-op for any caller that iterates.
    select: jest.fn().mockResolvedValue(selectResult ?? []),
    first: jest.fn().mockResolvedValue(firstResult),
    insert: jest.fn().mockReturnThis(),
    returning: jest.fn().mockResolvedValue(returningResult ?? insertResult ?? [{ id: 1 }]),
  };
  return chain;
};

jest.mock('../../../database/db', () => {
  const dbMock = jest.fn();
  dbMock.raw = jest.fn();
  dbMock.__setImplementations = (...chains) => {
    dbMock.mockReset();
    chains.forEach((chain) => {
      dbMock.mockImplementationOnce(() => chain);
    });
  };
  return {
    db: dbMock,
    logActivity: jest.fn().mockResolvedValue(undefined),
  };
});

jest.mock('../../../middleware/apiTokenAuth', () => ({
  apiTokenAuth: (req, _res, next) => {
    req.apiToken = { id: 1, admin_id: 1, scopes: ['admin'] };
    req.admin = { id: 1, username: 'token-admin' };
    next();
  },
  requireApiScope: () => (_req, _res, next) => next(),
}));

// bcrypt.hash is awaited twice per request (real path + dummy path).
// Stub it to a constant so tests don't burn CPU on bcrypt rounds.
jest.mock('bcrypt', () => ({
  hash: jest.fn().mockResolvedValue('$2b$10$mocked-hash'),
}));

jest.mock('../../../services/shareLinkService', () => ({
  buildShareLinkVariants: jest.fn().mockResolvedValue({
    shareUrl: 'https://example.test/gallery/some-slug?t=abc',
    shareLinkToStore: '/gallery/some-slug?t=abc',
  }),
}));

// Webhook fire is in a try/catch; stub to silence the predictable
// failure log so test output stays clean.
jest.mock('../../../services/webhookService', () => ({
  fire: jest.fn().mockResolvedValue(undefined),
  buildEventSubject: jest.fn().mockReturnValue({}),
}));

const { db } = require('../../../database/db');
const eventsRouter = require('../events');

const buildApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/', eventsRouter);
  return app;
};

const BASE_BODY = {
  event_name: 'Issue 550 Wedding',
  event_type: 'wedding',
  event_date: '2026-06-15',
  require_password: false,
};

// db() call sequence for BASE_BODY (no feedback / devtools provided,
// require_password supplied so its probe is skipped, no customer_phone,
// no slug collision):
//   1. app_settings.where('event_default_feedback_enabled').first()       (#550)
//   2. app_settings.where('enable_devtools_protection').first()           (#592)
//   3. app_settings.whereIn([branding_logo_display_hero,...]).select(...) (#592 follow-up)
// Then slug probe, events insert, optional feedback insert.
const baseSettingsChains = () => [
  buildChain({ firstResult: null }), // feedback default
  buildChain({ firstResult: null }), // devtools default
  buildChain({ selectResult: [] }),  // branding whereIn → empty rows
];

describe('v1 POST /events — issue #550 (color_theme + feedback row)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('persists color_theme to the events row when provided', async () => {
    const slugChain = buildChain({ firstResult: null });
    const insertChain = buildChain({ returningResult: [{ id: 42 }] });
    db.__setImplementations(...baseSettingsChains(), slugChain, insertChain);

    await request(buildApp())
      .post('/events')
      .send({ ...BASE_BODY, color_theme: 'default' })
      .expect(201);

    const insertedRow = insertChain.insert.mock.calls[0][0];
    expect(insertedRow).toMatchObject({
      event_name: 'Issue 550 Wedding',
      color_theme: 'default',
    });
  });

  it('accepts a JSON-encoded theme string and persists it verbatim', async () => {
    const slugChain = buildChain({ firstResult: null });
    const insertChain = buildChain({ returningResult: [{ id: 43 }] });
    db.__setImplementations(...baseSettingsChains(), slugChain, insertChain);

    const customTheme = JSON.stringify({ primaryColor: '#ff0066' });
    await request(buildApp())
      .post('/events')
      .send({ ...BASE_BODY, color_theme: customTheme })
      .expect(201);

    const insertedRow = insertChain.insert.mock.calls[0][0];
    expect(insertedRow.color_theme).toBe(customTheme);
  });

  it('creates event_feedback_settings row when feedback_enabled=true is sent', async () => {
    // feedback_enabled provided → feedback probe SKIPPED. Sequence:
    //   1. devtools probe
    //   2. branding probe (whereIn → select)
    //   3. slug probe
    //   4. events insert
    //   5. event_feedback_settings insert
    const devtoolsChain = buildChain({ firstResult: null });
    const brandingChain = buildChain({ selectResult: [] });
    const slugChain = buildChain({ firstResult: null });
    const insertChain = buildChain({ returningResult: [{ id: 50 }] });
    const feedbackInsertChain = buildChain();
    db.__setImplementations(devtoolsChain, brandingChain, slugChain, insertChain, feedbackInsertChain);

    await request(buildApp())
      .post('/events')
      .send({ ...BASE_BODY, feedback_enabled: true })
      .expect(201);

    expect(db).toHaveBeenNthCalledWith(5, 'event_feedback_settings');

    const feedbackRow = feedbackInsertChain.insert.mock.calls[0][0];
    expect(feedbackRow).toMatchObject({ event_id: 50 });
    // formatBoolean() returns 1/0 on SQLite and true/false on PG. Either
    // way the value must be truthy/falsy in the right places — assert by
    // coercion so the test stays driver-agnostic.
    expect(Boolean(feedbackRow.feedback_enabled)).toBe(true);
    expect(Boolean(feedbackRow.allow_ratings)).toBe(true);
    expect(Boolean(feedbackRow.allow_likes)).toBe(true);
    expect(Boolean(feedbackRow.allow_comments)).toBe(true);
    expect(Boolean(feedbackRow.allow_favorites)).toBe(true);
    expect(Boolean(feedbackRow.require_name_email)).toBe(false);
    expect(Boolean(feedbackRow.moderate_comments)).toBe(true);
    expect(Boolean(feedbackRow.show_feedback_to_guests)).toBe(true);
  });

  it('honours the event_default_feedback_enabled global when body omits feedback_enabled', async () => {
    // Feedback probe returns serialized "true" → fallback kicks in and
    // the feedback insert runs. Sequence: feedback probe, devtools probe,
    // branding probe, slug, insert, feedback insert (6 calls total).
    const feedbackProbe = buildChain({
      firstResult: { setting_key: 'event_default_feedback_enabled', setting_value: 'true' },
    });
    const devtoolsChain = buildChain({ firstResult: null });
    const brandingChain = buildChain({ selectResult: [] });
    const slugChain = buildChain({ firstResult: null });
    const insertChain = buildChain({ returningResult: [{ id: 51 }] });
    const feedbackInsertChain = buildChain();
    db.__setImplementations(
      feedbackProbe, devtoolsChain, brandingChain, slugChain, insertChain, feedbackInsertChain
    );

    await request(buildApp())
      .post('/events')
      .send(BASE_BODY)
      .expect(201);

    expect(db).toHaveBeenNthCalledWith(6, 'event_feedback_settings');
    expect(feedbackInsertChain.insert).toHaveBeenCalledTimes(1);
  });

  it('does NOT create a feedback row when global setting is unset and body omits feedback_enabled', async () => {
    const slugChain = buildChain({ firstResult: null });
    const insertChain = buildChain({ returningResult: [{ id: 52 }] });
    db.__setImplementations(...baseSettingsChains(), slugChain, insertChain);

    await request(buildApp())
      .post('/events')
      .send(BASE_BODY)
      .expect(201);

    // 5 db() calls: feedback + devtools + branding probes, slug, insert.
    // event_feedback_settings is never touched.
    expect(db).toHaveBeenCalledTimes(5);
    expect(db).not.toHaveBeenCalledWith('event_feedback_settings');
  });

  it('rejects non-boolean feedback_enabled with 400', async () => {
    // Validators run before any db() call, so no chain queueing needed.
    await request(buildApp())
      .post('/events')
      .send({ ...BASE_BODY, feedback_enabled: 'maybe' })
      .expect(400);
  });
});
