/**
 * Unit tests for rating removal (#884).
 *
 * Pins the contract of `feedbackService.submitFeedback` for
 * `feedback_type: 'rating'` with `rating: 0` ("clear my rating"):
 *  - An existing rating row is DELETED (not updated to 0 — a stored 0
 *    would drag the photo's average down and still count in totals).
 *  - Photo stats (average_rating) are recalculated after the delete.
 *  - Rating 0 with no existing rating is a no-op that never inserts a row.
 *  - Removal is guest-scoped: clearing guest A's rating leaves guest B's
 *    rating (and the resulting average) intact.
 *  - Regular re-rating (3 → 5) still updates in place.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-rating-removal-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'rating-removal-test-secret';

const { bootCrmDb, seedMinimal } = require('../integration/helpers/crmDb');

const feedbackService = require('../../src/services/feedbackService');

const EVENT_SLUG = 'rating-removal-event';
const GUEST_A = 'guest-a-identifier';
const GUEST_B = 'guest-b-identifier';

let db;
let cleanup;
let eventId;
let photoId;

async function rate(rating, guestIdentifier = GUEST_A) {
  return feedbackService.submitFeedback(photoId, eventId, {
    feedback_type: 'rating',
    rating,
    ip_address: '127.0.0.1',
    user_agent: 'jest',
  }, guestIdentifier);
}

async function ratingRows(guestIdentifier) {
  const q = db('photo_feedback').where({
    photo_id: photoId,
    feedback_type: 'rating',
  });
  if (guestIdentifier) q.where('guest_identifier', guestIdentifier);
  return q.select('*');
}

async function photoAverage() {
  const photo = await db('photos').where('id', photoId).first();
  return Number(photo.average_rating);
}

beforeAll(async () => {
  ({ db, cleanup } = await bootCrmDb());
  await seedMinimal(db);
  const inserted = await db('events').insert({
    slug: EVENT_SLUG,
    event_type: 'wedding',
    event_name: 'Rating Removal Test',
    event_date: '2026-06-22',
    host_email: 'host@example.com',
    admin_email: 'admin@example.com',
    password_hash: 'x',
    share_link: `/gallery/${EVENT_SLUG}/share`,
    share_token: 'rating-removal-share',
    expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
    is_active: 1,
    is_archived: 0,
    is_draft: 0,
    created_at: new Date().toISOString(),
  }).returning('id');
  eventId = inserted[0]?.id ?? inserted[0];

  const r = await db('photos').insert({
    event_id: eventId,
    filename: 'photo-1.jpg',
    path: 'events/rating-removal/1.jpg',
    type: 'individual',
    uploaded_at: new Date().toISOString(),
  }).returning('id');
  photoId = r[0]?.id ?? r[0];
}, 120000);

afterAll(async () => { if (cleanup) await cleanup(); });

beforeEach(async () => {
  await db('photo_feedback').where('event_id', eventId).del();
  await db('photos').where('id', photoId).update({ average_rating: 0, feedback_count: 0 });
});

describe('rating removal (#884)', () => {
  test('rating 0 deletes the existing rating row and resets the average', async () => {
    const created = await rate(4);
    expect(created.created).toBe(true);
    expect(await photoAverage()).toBe(4);

    const removed = await rate(0);
    expect(removed.removed).toBe(true);
    expect(await ratingRows(GUEST_A)).toHaveLength(0);
    expect(await photoAverage()).toBe(0);
  });

  test('rating 0 without an existing rating is a no-op (no 0-row inserted)', async () => {
    const r = await rate(0);
    expect(r.removed).toBe(true);
    expect(await ratingRows()).toHaveLength(0);
    expect(await photoAverage()).toBe(0);
  });

  test('removal is guest-scoped: guest B keeps their rating and the average', async () => {
    await rate(2, GUEST_A);
    await rate(4, GUEST_B);
    expect(await photoAverage()).toBe(3);

    const removed = await rate(0, GUEST_A);
    expect(removed.removed).toBe(true);
    expect(await ratingRows(GUEST_A)).toHaveLength(0);
    expect(await ratingRows(GUEST_B)).toHaveLength(1);
    expect(await photoAverage()).toBe(4);
  });

  test('numeric string "0" also clears (truthy-string bypass guard)', async () => {
    await rate(4);
    const removed = await rate('0');
    expect(removed.removed).toBe(true);
    expect(await ratingRows(GUEST_A)).toHaveLength(0);
    expect(await photoAverage()).toBe(0);
  });

  test('malformed rating input never clears an existing rating', async () => {
    await rate(4);
    for (const bad of [undefined, null, 'bad', NaN]) {
      const r = await rate(bad);
      expect(r.removed).toBeFalsy();
    }
    expect(await ratingRows(GUEST_A)).toHaveLength(1);
  });

  test('clearing deletes racy duplicate rating rows, not just the first', async () => {
    // Simulate the check-then-insert race: two rating rows for one guest.
    const row = {
      photo_id: photoId,
      event_id: eventId,
      feedback_type: 'rating',
      guest_identifier: GUEST_A,
      is_approved: 1,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    await db('photo_feedback').insert({ ...row, rating: 3 });
    await db('photo_feedback').insert({ ...row, rating: 5 });
    expect(await ratingRows(GUEST_A)).toHaveLength(2);

    const removed = await rate(0);
    expect(removed.removed).toBe(true);
    expect(await ratingRows(GUEST_A)).toHaveLength(0);
    expect(await photoAverage()).toBe(0);
  });

  test('re-rating with a different value still updates in place', async () => {
    await rate(3);
    const updated = await rate(5);
    expect(updated.updated).toBe(true);
    const rows = await ratingRows(GUEST_A);
    expect(rows).toHaveLength(1);
    expect(rows[0].rating).toBe(5);
    expect(await photoAverage()).toBe(5);
  });
});
