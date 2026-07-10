/**
 * Unit tests for the per-guest favorite/like cap (#655).
 *
 * Pins the contract of `feedbackService.submitFeedback` around the cap:
 *  - null / 0 cap means unlimited (back-compat for installs that don't
 *    enable the feature).
 *  - At-cap ADD returns `{ limit_reached, limit, current_count }` rather
 *    than inserting — the route layer translates that into the structured
 *    403 the UI listens for.
 *  - Toggle-off (un-favoriting) is ALWAYS allowed, regardless of cap state.
 *    A guest at 10/10 can still free a slot.
 *  - Limit reduction (admin lowers 20 → 10 while a guest has 15 already)
 *    grandfathers existing rows — new adds blocked, removals always allowed.
 *  - Caps are per-feedback-type: filling the favorite quota doesn't block
 *    likes on the same photo, and vice versa.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-feedback-limit-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'feedback-limit-test-secret';

const { bootCrmDb, seedMinimal } = require('../integration/helpers/crmDb');

const feedbackService = require('../../src/services/feedbackService');

const EVENT_SLUG = 'cap-test-event';
const GUEST_A = 'guest-a-identifier';
const GUEST_B = 'guest-b-identifier';

let db;
let cleanup;
let eventId;
let photoIds;

async function setEventFeedbackSettings(overrides) {
  const base = {
    feedback_enabled: 1,
    allow_ratings: 1,
    allow_likes: 1,
    allow_comments: 0,
    allow_favorites: 1,
    require_name_email: 0,
    moderate_comments: 0,
    show_feedback_to_guests: 1,
    identity_mode: 'simple',
    max_favorites_per_guest: null,
    max_likes_per_guest: null,
    ...overrides,
  };
  const existing = await db('event_feedback_settings').where('event_id', eventId).first();
  if (existing) {
    await db('event_feedback_settings').where('event_id', eventId).update(base);
  } else {
    await db('event_feedback_settings').insert({
      event_id: eventId,
      ...base,
      created_at: new Date(),
      updated_at: new Date(),
    });
  }
}

async function favorite(photoId, guestIdentifier = GUEST_A) {
  return feedbackService.submitFeedback(photoId, eventId, {
    feedback_type: 'favorite',
    ip_address: '127.0.0.1',
    user_agent: 'jest',
  }, guestIdentifier);
}

async function like(photoId, guestIdentifier = GUEST_A) {
  return feedbackService.submitFeedback(photoId, eventId, {
    feedback_type: 'like',
    ip_address: '127.0.0.1',
    user_agent: 'jest',
  }, guestIdentifier);
}

beforeAll(async () => {
  ({ db, cleanup } = await bootCrmDb());
  await seedMinimal(db);
  const inserted = await db('events').insert({
    slug: EVENT_SLUG,
    event_type: 'wedding',
    event_name: 'Cap Test',
    event_date: '2026-06-22',
    host_email: 'host@example.com',
    admin_email: 'admin@example.com',
    password_hash: 'x',
    share_link: `/gallery/${EVENT_SLUG}/share`,
    share_token: 'cap-test-share',
    expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
    is_active: 1,
    is_archived: 0,
    is_draft: 0,
    created_at: new Date().toISOString(),
  }).returning('id');
  eventId = inserted[0]?.id ?? inserted[0];

  // Seed 15 photos so we can test caps comfortably up to that count.
  photoIds = [];
  for (let i = 1; i <= 15; i += 1) {
    const r = await db('photos').insert({
      event_id: eventId,
      filename: `photo-${i}.jpg`,
      path: `events/cap/${i}.jpg`,
      type: 'individual',
      uploaded_at: new Date().toISOString(),
    }).returning('id');
    photoIds.push(r[0]?.id ?? r[0]);
  }
}, 30000);

afterAll(async () => { if (cleanup) await cleanup(); });

beforeEach(async () => {
  await db('photo_feedback').where('event_id', eventId).del();
});

describe('per-guest favorite cap (#655)', () => {
  test('null cap = unlimited (back-compat for installs without #655)', async () => {
    await setEventFeedbackSettings({ max_favorites_per_guest: null });
    for (const id of photoIds.slice(0, 12)) {
      const r = await favorite(id);
      expect(r.limit_reached).toBeFalsy();
      expect(r.created).toBe(true);
    }
  });

  test('cap = 0 also = unlimited (UI convenience for "no limit")', async () => {
    await setEventFeedbackSettings({ max_favorites_per_guest: 0 });
    for (const id of photoIds.slice(0, 12)) {
      const r = await favorite(id);
      expect(r.limit_reached).toBeFalsy();
    }
  });

  test('cap = 10: favorites 1..10 succeed, 11 returns limit_reached', async () => {
    await setEventFeedbackSettings({ max_favorites_per_guest: 10 });
    for (const id of photoIds.slice(0, 10)) {
      const r = await favorite(id);
      expect(r.created).toBe(true);
    }
    const r11 = await favorite(photoIds[10]);
    expect(r11.limit_reached).toBe(true);
    expect(r11.limit).toBe(10);
    expect(r11.current_count).toBe(10);
    expect(r11.feedback_type).toBe('favorite');
  });

  test('toggle-off at the cap frees a slot (un-favoriting always allowed)', async () => {
    await setEventFeedbackSettings({ max_favorites_per_guest: 5 });
    for (const id of photoIds.slice(0, 5)) {
      await favorite(id);
    }
    const blocked = await favorite(photoIds[5]);
    expect(blocked.limit_reached).toBe(true);

    // Un-favorite one — toggle off path returns { removed: true }
    const removed = await favorite(photoIds[0]);
    expect(removed.removed).toBe(true);

    // Now the previously-blocked slot fits
    const after = await favorite(photoIds[5]);
    expect(after.created).toBe(true);
  });

  test('limit reduction grandfathers existing rows; new adds blocked', async () => {
    await setEventFeedbackSettings({ max_favorites_per_guest: 10 });
    for (const id of photoIds.slice(0, 10)) {
      await favorite(id);
    }
    // Admin lowers the cap to 5 while the guest already has 10
    await setEventFeedbackSettings({ max_favorites_per_guest: 5 });
    // Existing 10 stay
    const count = await db('photo_feedback')
      .where({ event_id: eventId, feedback_type: 'favorite', guest_identifier: GUEST_A })
      .count('* as c').first();
    expect(parseInt(count.c, 10)).toBe(10);
    // New adds blocked
    const blocked = await favorite(photoIds[10]);
    expect(blocked.limit_reached).toBe(true);
    expect(blocked.limit).toBe(5);
    expect(blocked.current_count).toBe(10);
    // Removals still allowed
    const removed = await favorite(photoIds[0]);
    expect(removed.removed).toBe(true);
  });

  test('cap is per-guest: guest B is unaffected by guest A hitting the cap', async () => {
    await setEventFeedbackSettings({ max_favorites_per_guest: 3 });
    for (const id of photoIds.slice(0, 3)) {
      await favorite(id, GUEST_A);
    }
    expect((await favorite(photoIds[3], GUEST_A)).limit_reached).toBe(true);

    // Guest B starts at 0
    for (const id of photoIds.slice(0, 3)) {
      const r = await favorite(id, GUEST_B);
      expect(r.created).toBe(true);
    }
    expect((await favorite(photoIds[3], GUEST_B)).limit_reached).toBe(true);
  });
});

describe('per-guest like cap (#655)', () => {
  test('favorite cap does NOT block likes on the same photo (per-type)', async () => {
    await setEventFeedbackSettings({
      max_favorites_per_guest: 3,
      max_likes_per_guest: null,
    });
    for (const id of photoIds.slice(0, 3)) {
      await favorite(id);
    }
    expect((await favorite(photoIds[3])).limit_reached).toBe(true);

    // Likes still unlimited
    for (const id of photoIds.slice(0, 10)) {
      const r = await like(id);
      expect(r.created).toBe(true);
    }
  });

  test('like cap returns LIKE_LIMIT_REACHED-shaped payload', async () => {
    await setEventFeedbackSettings({ max_likes_per_guest: 2 });
    await like(photoIds[0]);
    await like(photoIds[1]);
    const r = await like(photoIds[2]);
    expect(r.limit_reached).toBe(true);
    expect(r.feedback_type).toBe('like');
    expect(r.limit).toBe(2);
    expect(r.current_count).toBe(2);
  });
});
