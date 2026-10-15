/**
 * Guest feedback counters and the rating race (issues 2071, 2075, 2077).
 *
 * - comment_count is written by the stats recount, so the admin "Has comments"
 *   filter finds a photo once a comment is approved, and migration 309
 *   backfills the rows that predate it.
 * - Parallel first ratings from one guest end as one row, and the migration
 *   collapses duplicates that already exist before adding the unique index.
 * - The comment answer only says "submitted for moderation" for a comment
 *   that is actually held.
 */
const request = require('supertest');
const jwt = require('jsonwebtoken');
const { randomUUID } = require('crypto');
const { bootCrmDb, seedMinimal, buildRouteApp } = require('./helpers/crmDb');

const SLUG = 'feedback-counts';
let db; let cleanup; let app; let eventId; let token; let feedbackService;
let photoId; let seq = 0;

const insertPhoto = async (extra = {}) => {
  seq += 1;
  const [photo] = await db('photos').insert({
    event_id: eventId, filename: `p${seq}.jpg`, path: `${eventId}/p${seq}.jpg`, type: 'individual', ...extra,
  }).returning('id');
  return photo.id ?? photo;
};
const setModeration = (on) => db('event_feedback_settings').where({ event_id: eventId })
  .update({ moderate_comments: on });
const ratingRows = (id = photoId) => db('photo_feedback')
  .where({ photo_id: id, feedback_type: 'rating' }).select('id', 'rating', 'guest_identifier', 'guest_id', 'is_hidden');
const commentCount = async (id = photoId) => Number((await db('photos').where({ id }).first('comment_count')).comment_count);

beforeAll(async () => {
  ({ db, cleanup } = await bootCrmDb());
  await seedMinimal(db);
  const [event] = await db('events').insert({
    slug: SLUG, event_type: 'wedding', event_name: SLUG, event_date: '2026-09-16',
    host_email: 'h@example.test', admin_email: 'a@example.test', password_hash: 'unused',
    share_link: `/gallery/${SLUG}/share`, is_active: true, is_archived: false, is_draft: false,
  }).returning('id');
  eventId = event.id ?? event;
  await db('event_feedback_settings').insert({
    event_id: eventId, feedback_enabled: true, identity_mode: 'simple', allow_ratings: true,
    allow_comments: true, show_feedback_to_guests: true, moderate_comments: false, require_moderation: false,
  });
  feedbackService = require('../../src/services/feedbackService');
  app = buildRouteApp('/api/gallery', require('../../src/routes/galleryFeedback'));
  token = jwt.sign({ eventId, eventSlug: SLUG, type: 'gallery', jti: randomUUID() }, process.env.JWT_SECRET,
    { issuer: 'picpeak-auth', expiresIn: '1h' });
});
afterAll(async () => { if (cleanup) await cleanup(); });
beforeEach(async () => {
  await db('feedback_rate_limits').delete();
  await db('photo_feedback').delete();
  await setModeration(false);
  photoId = await insertPhoto();
});

describe('comment_count (issue 2071)', () => {
  const comment = (extra = {}) => db('photo_feedback').insert({
    photo_id: photoId, event_id: eventId, feedback_type: 'comment', comment_text: 'nice',
    guest_identifier: 'g1', is_approved: true, is_hidden: false, created_at: new Date().toISOString(),
    ...extra,
  }).returning('id');

  test('counts approved comments only, and follows moderation', async () => {
    const [pending] = await comment({ is_approved: false });
    await comment();
    await feedbackService.updatePhotoFeedbackStats(photoId);
    expect(await commentCount()).toBe(1);

    await feedbackService.moderateFeedback(pending.id ?? pending, 'approve', null);
    expect(await commentCount()).toBe(2);
    await feedbackService.moderateFeedback(pending.id ?? pending, 'reject', null);
    expect(await commentCount()).toBe(1);
  });

  test('a guest comment through the route lands in the column', async () => {
    await request(app).post(`/api/gallery/${SLUG}/photos/${photoId}/feedback`)
      .set('Authorization', `Bearer ${token}`)
      .send({ feedback_type: 'comment', comment_text: 'lovely shot', guest_name: 'Ann' })
      .expect(200);
    expect(await commentCount()).toBe(1);
  });

  test('migration 309 backfills photos whose comments predate the counter', async () => {
    await comment();
    await comment({ is_approved: false });
    await comment({ is_hidden: true });
    await db('photos').where({ id: photoId }).update({ comment_count: 0 });
    await require('../../migrations/core/309_photo_feedback_rating_unique_comment_count').up(db);
    expect(await commentCount()).toBe(1);
  });
});

describe('comment toast (issue 2077)', () => {
  const post = () => request(app).post(`/api/gallery/${SLUG}/photos/${photoId}/feedback`)
    .set('Authorization', `Bearer ${token}`)
    .send({ feedback_type: 'comment', comment_text: 'great', guest_name: 'Ann' });

  test('an auto-approved comment carries no moderation message', async () => {
    const res = await post().expect(200);
    expect(res.body.message).toBeUndefined();
    expect((await db('photo_feedback').where({ photo_id: photoId }).first()).is_approved).toBeTruthy();
  });

  test('a held comment still says so', async () => {
    await setModeration(true);
    const res = await post().expect(200);
    expect(res.body.message).toBe('Your comment has been submitted for moderation');
    expect((await db('photo_feedback').where({ photo_id: photoId }).first()).is_approved).toBeFalsy();
  });
});

describe('one rating per guest (issue 2075)', () => {
  const rate = (rating, guestId = null, identifier = 'racer') => feedbackService.submitFeedback(
    photoId, eventId, { feedback_type: 'rating', rating, guest_id: guestId }, identifier,
  );

  test('parallel first ratings from one guest leave exactly one row', async () => {
    const results = await Promise.all([1, 2, 3, 4, 5, 4, 4, 4].map((r) => rate(r)));
    expect(results.every((r) => r && !r.limit_reached)).toBe(true);
    const rows = Array.from(await ratingRows());
    expect(rows).toHaveLength(1);
    const photo = await db('photos').where({ id: photoId }).first('average_rating');
    expect(Number(photo.average_rating)).toBe(Number(rows[0].rating));
  });

  test('two guests on one device and a hidden row still coexist', async () => {
    const [a, b] = await db('gallery_guests').insert([
      { event_id: eventId, name: 'A', identifier: `a-${seq}`, is_deleted: false },
      { event_id: eventId, name: 'B', identifier: `b-${seq}`, is_deleted: false },
    ]).returning('id').then((rows) => rows.map((r) => r.id ?? r));
    await Promise.all([rate(4, a, 'device'), rate(2, b, 'device')]);
    await db('photo_feedback').insert({
      photo_id: photoId, event_id: eventId, feedback_type: 'rating', rating: 1,
      guest_identifier: 'device', guest_id: a, is_approved: true, is_hidden: true,
    });
    expect(Array.from(await ratingRows())).toHaveLength(3);
  });

  test('migration 309 keeps the row changed last and fixes the average', async () => {
    const migration = require('../../migrations/core/309_photo_feedback_rating_unique_comment_count');
    await migration.down(db);
    const base = { photo_id: photoId, event_id: eventId, feedback_type: 'rating', is_approved: true, is_hidden: false };
    await db('photo_feedback').insert([
      { ...base, rating: 1, guest_identifier: 'dup', created_at: '2026-01-01T10:00:00.000Z', updated_at: '2026-01-01T10:00:00.000Z' },
      { ...base, rating: 5, guest_identifier: 'dup', created_at: '2026-01-01T10:00:01.000Z', updated_at: '2026-01-01T10:00:05.000Z' },
      { ...base, rating: 3, guest_identifier: 'dup', created_at: '2026-01-01T10:00:02.000Z', updated_at: '2026-01-01T10:00:02.000Z' },
      { ...base, rating: 2, guest_identifier: 'solo', created_at: '2026-01-01T10:00:00.000Z' },
    ]);
    await migration.up(db);
    const rows = Array.from(await ratingRows());
    expect(rows.map((r) => `${r.guest_identifier}:${r.rating}`).sort()).toEqual(['dup:5', 'solo:2']);
    expect(Number((await db('photos').where({ id: photoId }).first('average_rating')).average_rating)).toBe(3.5);

    // Idempotent, and the index is back.
    await migration.up(db);
    expect(Array.from(await ratingRows())).toHaveLength(2);
    await expect(db('photo_feedback').insert({ ...base, rating: 4, guest_identifier: 'solo' })).rejects.toThrow();
  });

  test('approving a hidden rating replaces the guest\'s newer one instead of failing', async () => {
    const base = { photo_id: photoId, event_id: eventId, feedback_type: 'rating', is_approved: true };
    const [hidden] = await db('photo_feedback')
      .insert({ ...base, rating: 2, guest_identifier: 'mod', is_hidden: true }).returning('id');
    await rate(5, null, 'mod');

    await feedbackService.moderateFeedback(hidden.id ?? hidden, 'approve', null);

    const rows = Array.from(await ratingRows());
    expect(rows.map((r) => [Number(r.id), Number(r.rating), Boolean(r.is_hidden)]))
      .toEqual([[Number(hidden.id ?? hidden), 2, false]]);
    expect(Number((await db('photos').where({ id: photoId }).first('average_rating')).average_rating)).toBe(2);
  });

  test('a restore of a pre-309 archive loads its duplicate ratings and comes back constrained', async () => {
    const feedbackIntegrity = require('../../src/services/feedbackIntegrity');
    const base = { photo_id: photoId, event_id: eventId, feedback_type: 'rating', is_approved: true, is_hidden: false };
    const archive = [
      { ...base, rating: 1, guest_identifier: 'old', created_at: '2026-01-01T10:00:00.000Z', updated_at: '2026-01-01T10:00:00.000Z' },
      { ...base, rating: 4, guest_identifier: 'old', created_at: '2026-01-01T10:00:01.000Z', updated_at: '2026-01-01T10:00:01.000Z' },
    ];
    // What replaceAllTables hits without the drop.
    await expect(db.batchInsert('photo_feedback', archive, 10)).rejects.toThrow(/unique/i);

    await db.transaction(async (trx) => {
      expect(await feedbackIntegrity.ratingIndexesSupported(trx)).toBe(true);
      await feedbackIntegrity.dropRatingIndexes(trx);
      await trx.batchInsert('photo_feedback', archive, 10);
      expect(await feedbackIntegrity.dedupeRatings(trx)).toBe(1);
      await feedbackIntegrity.createRatingIndexes(trx);
    });
    expect(Array.from(await ratingRows()).map((r) => Number(r.rating))).toEqual([4]);
    await expect(db('photo_feedback').insert({ ...base, rating: 3, guest_identifier: 'old' })).rejects.toThrow();

    // And the restore runs that sequence around its load.
    const source = require('fs').readFileSync(require.resolve('../../src/services/picpeakImportService'), 'utf8');
    const body = source.slice(source.indexOf('async function replaceAllTables'));
    const at = (needle) => body.indexOf(needle);
    expect(at('await dropRatingIndexes(trx)')).toBeGreaterThan(-1);
    expect(at('await dropRatingIndexes(trx)')).toBeLessThan(at('trx.batchInsert(table'));
    expect(at('await dedupeRatings(trx)')).toBeGreaterThan(at('trx.batchInsert(table'));
    expect(at('await createRatingIndexes(trx)')).toBeGreaterThan(at('await dedupeRatings(trx)'));
    // The comment counters such an archive carries are recounted too (issue 2071).
    expect(at('await backfillCommentCounts(trx)')).toBeGreaterThan(at('trx.batchInsert(table'));
  });

  test('an empty identifier is no identity: migration 309 and moderation leave such ratings alone', async () => {
    const migration = require('../../migrations/core/309_photo_feedback_rating_unique_comment_count');
    await migration.down(db);
    const base = { photo_id: photoId, event_id: eventId, feedback_type: 'rating', is_approved: true, guest_identifier: '' };
    const [hidden] = await db('photo_feedback').insert([
      { ...base, rating: 1, is_hidden: true },
      { ...base, rating: 2, is_hidden: false },
      { ...base, rating: 4, is_hidden: false },
    ]).returning('id');
    await migration.up(db);
    expect(Array.from(await ratingRows()).map((r) => Number(r.rating)).sort()).toEqual([1, 2, 4]);

    await feedbackService.moderateFeedback(hidden.id ?? hidden, 'approve', null);
    expect(Array.from(await ratingRows()).filter((r) => !r.is_hidden)).toHaveLength(3);
  });

  test('erasing a guest whose device also rated anonymously keeps one rating instead of failing', async () => {
    const [guest] = await db('gallery_guests')
      .insert({ event_id: eventId, name: 'C', identifier: `c-${seq}`, is_deleted: false }).returning('id');
    const guestId = guest.id ?? guest;
    const base = { photo_id: photoId, event_id: eventId, feedback_type: 'rating', is_approved: true, is_hidden: false, guest_identifier: 'shared' };
    await db('photo_feedback').insert([
      { ...base, rating: 1, guest_id: null, created_at: '2026-01-01T10:00:00.000Z', updated_at: '2026-01-01T10:00:00.000Z' },
      { ...base, rating: 5, guest_id: guestId, created_at: '2026-01-01T10:00:01.000Z', updated_at: '2026-01-01T10:00:01.000Z' },
    ]);
    const other = await insertPhoto();
    await db('photo_feedback').insert({ ...base, photo_id: other, rating: 3, guest_id: guestId });

    await feedbackService.anonymizeGuestFeedback(guestId);

    const rows = Array.from(await db('photo_feedback').where({ feedback_type: 'rating' })
      .whereIn('photo_id', [photoId, other]).select('photo_id', 'rating', 'guest_id'));
    expect(rows.map((r) => [Number(r.photo_id), Number(r.rating), r.guest_id]).sort())
      .toEqual([[Number(photoId), 5, null], [Number(other), 3, null]].sort());
    expect(Number((await db('photos').where({ id: photoId }).first('average_rating')).average_rating)).toBe(5);
  });
});
