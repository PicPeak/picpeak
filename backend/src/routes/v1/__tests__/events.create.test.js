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

const buildChain = ({ firstResult, insertResult, returningResult } = {}) => {
  const chain = {
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orWhere: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
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

describe('v1 POST /events — issue #550 (color_theme + feedback row)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('persists color_theme to the events row when provided', async () => {
    // db() call sequence for this body (feedback_enabled omitted, no
    // customer_phone, no slug collision):
    //   1. app_settings.where('event_default_feedback_enabled').first()
    //   2. events.where({ slug }).first()   ← uniqueness probe
    //   3. events.insert(...).returning('id')
    // No event_feedback_settings insert because the global setting
    // returns nothing (feedback stays off) — covered separately below.
    const settingChain = buildChain({ firstResult: null });
    const slugChain = buildChain({ firstResult: null });
    const insertChain = buildChain({ returningResult: [{ id: 42 }] });
    db.__setImplementations(settingChain, slugChain, insertChain);

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
    db.__setImplementations(
      buildChain({ firstResult: null }),
      buildChain({ firstResult: null }),
      buildChain({ returningResult: [{ id: 43 }] }),
    );

    const customTheme = JSON.stringify({ primaryColor: '#ff0066' });
    await request(buildApp())
      .post('/events')
      .send({ ...BASE_BODY, color_theme: customTheme })
      .expect(201);

    const insertedRow = db.mock.results[2].value.insert.mock.calls[0][0];
    expect(insertedRow.color_theme).toBe(customTheme);
  });

  it('creates event_feedback_settings row when feedback_enabled=true is sent', async () => {
    // 3 db() calls when feedback_enabled is sent explicitly (the
    // settings probe is skipped because feedbackEnabledInput !== undefined):
    //   1. slug probe, 2. events insert, 3. feedback insert
    const slugChain = buildChain({ firstResult: null });
    const insertChain = buildChain({ returningResult: [{ id: 50 }] });
    const feedbackInsertChain = buildChain();
    db.__setImplementations(slugChain, insertChain, feedbackInsertChain);

    await request(buildApp())
      .post('/events')
      .send({ ...BASE_BODY, feedback_enabled: true })
      .expect(201);

    // db('event_feedback_settings') is the 3rd invocation.
    expect(db).toHaveBeenNthCalledWith(3, 'event_feedback_settings');

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
    // settings probe returns a serialized "true" — fallback should kick
    // in and the feedback row should still be written.
    const settingChain = buildChain({
      firstResult: { setting_key: 'event_default_feedback_enabled', setting_value: 'true' },
    });
    const slugChain = buildChain({ firstResult: null });
    const insertChain = buildChain({ returningResult: [{ id: 51 }] });
    const feedbackInsertChain = buildChain();
    db.__setImplementations(settingChain, slugChain, insertChain, feedbackInsertChain);

    await request(buildApp())
      .post('/events')
      .send(BASE_BODY)
      .expect(201);

    expect(db).toHaveBeenNthCalledWith(4, 'event_feedback_settings');
    expect(feedbackInsertChain.insert).toHaveBeenCalledTimes(1);
  });

  it('does NOT create a feedback row when global setting is unset and body omits feedback_enabled', async () => {
    const settingChain = buildChain({ firstResult: null });
    const slugChain = buildChain({ firstResult: null });
    const insertChain = buildChain({ returningResult: [{ id: 52 }] });
    db.__setImplementations(settingChain, slugChain, insertChain);

    await request(buildApp())
      .post('/events')
      .send(BASE_BODY)
      .expect(201);

    // Only 3 db() calls — the event_feedback_settings table is never
    // touched because feedback_enabled resolved to false.
    expect(db).toHaveBeenCalledTimes(3);
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
