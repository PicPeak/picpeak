/**
 * Regression tests for the feedback-settings write path (#1030).
 *
 * The admin event form posts its whole client-side feedback state back,
 * including three keys that were never columns on event_feedback_settings:
 * `enable_rate_limiting`, `rate_limit_window_minutes` and
 * `rate_limit_max_requests`. Spreading those into the knex UPDATE threw,
 * the route answered 500, and EventDetailsPage swallowed it — so the admin
 * saw "Event updated successfully" while "Enable feedback" never persisted
 * and guests could not leave any feedback.
 *
 * Pinned here:
 *  - UI-only keys are dropped, not written, on BOTH the insert (no row yet)
 *    and update (row exists) branches.
 *  - Every real column still round-trips.
 *  - Identity columns can't be mass-assigned through the settings body.
 *  - gallery.js no longer declares a duplicate GET /:slug/feedback-settings.
 *    server.js mounts galleryRoutes before galleryFeedback, so the duplicate
 *    shadowed the real handler and dropped the #655 per-guest caps from the
 *    guest payload.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-feedback-settings-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'feedback-settings-test-secret';

const { bootCrmDb, seedMinimal } = require('../integration/helpers/crmDb');

const feedbackService = require('../../src/services/feedbackService');

// Exactly what EventDetailsPage holds in state before its settings GET
// resolves — the three rate-limit keys are UI-only.
const ADMIN_FORM_BODY = {
  feedback_enabled: true,
  allow_ratings: true,
  allow_likes: true,
  allow_comments: true,
  allow_favorites: true,
  allow_reactions: true,
  require_name_email: false,
  moderate_comments: true,
  show_feedback_to_guests: true,
  enable_rate_limiting: false,
  rate_limit_window_minutes: 15,
  rate_limit_max_requests: 10,
};

let db;
let cleanup;
let eventId;

async function insertEvent(slug) {
  const inserted = await db('events').insert({
    slug,
    event_type: 'wedding',
    event_name: 'Feedback Settings Test',
    event_date: '2026-06-22',
    host_email: 'host@example.com',
    admin_email: 'admin@example.com',
    password_hash: 'x',
    share_link: `/gallery/${slug}/share`,
    share_token: `${slug}-share`,
    expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
    is_active: 1,
    is_archived: 0,
    is_draft: 0,
    created_at: new Date().toISOString(),
  }).returning('id');
  return inserted[0]?.id ?? inserted[0];
}

beforeAll(async () => {
  ({ db, cleanup } = await bootCrmDb());
  await seedMinimal(db);
  eventId = await insertEvent('feedback-settings-test');
}, 120000);

afterAll(async () => { if (cleanup) await cleanup(); });

describe('updateEventFeedbackSettings ignores UI-only keys (#1030)', () => {
  test('insert branch: enabling feedback on an event with no settings row persists', async () => {
    const freshEventId = await insertEvent('feedback-settings-fresh');

    const result = await feedbackService.updateEventFeedbackSettings(freshEventId, ADMIN_FORM_BODY);

    expect(result.feedback_enabled).toBeTruthy();
    const row = await db('event_feedback_settings').where('event_id', freshEventId).first();
    expect(row).toBeTruthy();
    expect(row.feedback_enabled).toBeTruthy();
    expect(row).not.toHaveProperty('enable_rate_limiting');
  });

  test('update branch: flipping the toggle on an existing row persists', async () => {
    await feedbackService.updateEventFeedbackSettings(eventId, { feedback_enabled: false });
    expect((await feedbackService.getEventFeedbackSettings(eventId)).feedback_enabled).toBeFalsy();

    const result = await feedbackService.updateEventFeedbackSettings(eventId, ADMIN_FORM_BODY);

    expect(result.feedback_enabled).toBeTruthy();
    const rows = await db('event_feedback_settings').where('event_id', eventId);
    expect(rows).toHaveLength(1);
    expect(rows[0].feedback_enabled).toBeTruthy();
  });

  test('every real column round-trips', async () => {
    const result = await feedbackService.updateEventFeedbackSettings(eventId, {
      ...ADMIN_FORM_BODY,
      allow_comments: false,
      show_feedback_to_guests: false,
      identity_mode: 'guest',
      max_favorites_per_guest: 10,
      max_likes_per_guest: 5,
    });

    expect(result.allow_comments).toBeFalsy();
    expect(result.show_feedback_to_guests).toBeFalsy();
    expect(result.identity_mode).toBe('guest');
    expect(result.max_favorites_per_guest).toBe(10);
    expect(result.max_likes_per_guest).toBe(5);
  });

  test('identity columns cannot be mass-assigned through the settings body', async () => {
    const otherEventId = await insertEvent('feedback-settings-other');
    const before = await db('event_feedback_settings').where('event_id', eventId).first();

    await feedbackService.updateEventFeedbackSettings(eventId, {
      feedback_enabled: true,
      id: 99999,
      event_id: otherEventId,
    });

    const after = await db('event_feedback_settings').where('event_id', eventId).first();
    expect(after.id).toBe(before.id);
    expect(after.event_id).toBe(eventId);
    expect(await db('event_feedback_settings').where('event_id', otherEventId).first()).toBeUndefined();
  });
});

describe('guest feedback-settings route is not shadowed (#1030)', () => {
  test('gallery.js does not declare GET /:slug/feedback-settings', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '..', '..', 'src', 'routes', 'gallery.js'), 'utf8',
    );
    expect(source).not.toMatch(/router\.get\(\s*['"]\/:slug\/feedback-settings['"]/);
  });

  test('galleryFeedback.js still serves it, including the #655 per-guest caps', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '..', '..', 'src', 'routes', 'galleryFeedback.js'), 'utf8',
    );
    expect(source).toMatch(/router\.get\(\s*['"]\/:slug\/feedback-settings['"]/);
    expect(source).toMatch(/max_favorites_per_guest/);
    expect(source).toMatch(/max_likes_per_guest/);
  });
});
