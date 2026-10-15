/**
 * POST /:slug/feedback/bulk (issue 1733): rate a selection in one request.
 *
 * Every photo passes the single route's checks, each rated photo costs one
 * unit of the rating budget, and a selection the budget does not cover is
 * refused whole.
 */
const request = require('supertest');
const jwt = require('jsonwebtoken');
const { randomUUID } = require('crypto');
const { bootCrmDb, seedMinimal, buildRouteApp } = require('./helpers/crmDb');

const SLUG = 'bulk-rating';
let db; let cleanup; let app; let eventId; let token;
let photoIds; let hiddenPhotoId; let foreignPhotoId;

const insertEvent = async (slug) => {
  const [event] = await db('events').insert({ slug, event_type: 'wedding', event_name: slug,
    event_date: '2026-09-16', host_email: 'h@example.test', admin_email: 'a@example.test',
    password_hash: 'unused', share_link: `/gallery/${slug}/share`, is_active: true, is_archived: false, is_draft: false }).returning('id');
  return event.id ?? event;
};
const insertPhoto = async (event, filename, extra = {}) => {
  const [photo] = await db('photos').insert({ event_id: event, filename, path: `${event}/${filename}`, type: 'individual', ...extra }).returning('id');
  return photo.id ?? photo;
};

beforeAll(async () => {
  ({ db, cleanup } = await bootCrmDb());
  await seedMinimal(db);
  eventId = await insertEvent(SLUG);
  photoIds = [];
  for (let i = 0; i < 4; i++) photoIds.push(await insertPhoto(eventId, `p${i}.jpg`));
  hiddenPhotoId = await insertPhoto(eventId, 'hidden.jpg', { visibility: 'hidden' });
  foreignPhotoId = await insertPhoto(await insertEvent('bulk-rating-other'), 'foreign.jpg');
  await db('event_feedback_settings').insert({ event_id: eventId, feedback_enabled: true, identity_mode: 'simple',
    allow_ratings: true, show_feedback_to_guests: true, moderate_comments: false, require_moderation: false });
  await db('app_settings').where({ setting_key: 'feedback_rate_limits' }).update({
    setting_value: JSON.stringify({ rating: { max: 5, window: 3600 } })
  });
  app = buildRouteApp('/api/gallery', require('../../src/routes/galleryFeedback'));
  token = jwt.sign({ eventId, eventSlug: SLUG, type: 'gallery', jti: randomUUID() }, process.env.JWT_SECRET,
    { issuer: 'picpeak-auth', expiresIn: '1h' });
});
afterAll(async () => { if (cleanup) await cleanup(); });
beforeEach(async () => {
  await db('feedback_rate_limits').delete();
  await db('photo_feedback').delete();
  await db('event_feedback_settings').where({ event_id: eventId }).update({ allow_ratings: true, require_name_email: false, show_feedback_to_guests: true });
});

const bulk = (client, data) => client.post(`/api/gallery/${SLUG}/feedback/bulk`)
  .set('Authorization', `Bearer ${token}`).send(data);
const single = (client, photoId, rating) => client.post(`/api/gallery/${SLUG}/photos/${photoId}/feedback`)
  .set('Authorization', `Bearer ${token}`).send({ feedback_type: 'rating', rating });
const ratings = async () => Object.fromEntries((await db('photo_feedback').where({ feedback_type: 'rating' })
  .select('photo_id', 'rating')).map(row => [row.photo_id, Number(row.rating)]));
// Two rows per reservation (browser + IP budget), each carrying the unit count.
const unitsSpent = async () => {
  const rows = Array.from(await db('feedback_rate_limits').where({ action_type: 'rating' }).select('identifier', 'action_count'));
  const perIdentifier = {};
  rows.forEach((row) => { perIdentifier[row.identifier] = (perIdentifier[row.identifier] || 0) + Number(row.action_count); });
  return [...new Set(Object.values(perIdentifier))];
};

test('rates every listed photo and spends exactly one unit per photo', async () => {
  const ids = photoIds.slice(0, 3);
  const res = await bulk(request.agent(app), { photo_ids: ids, rating: 4 }).expect(200);
  expect(res.body.results).toEqual(ids.map(id => expect.objectContaining({
    photo_id: id, success: true, created: true, average_rating: 4, total_ratings: 1,
  })));
  expect(await ratings()).toEqual(Object.fromEntries(ids.map(id => [id, 4])));
  expect(await unitsSpent()).toEqual([3]);
  expect(res.headers['x-ratelimit-remaining']).toBe('2');
});

// The frontend writes the answer into the cached photo list and does not
// refetch it, so the answer has to carry what that viewer's list carries: the
// aggregates for a guest only while feedback is shared, for the PIN client
// always (galleryQueryService: isClient || show_feedback_to_guests).
test('with sharing off the aggregates go to the PIN client and not to a guest', async () => {
  await db('event_feedback_settings').where({ event_id: eventId }).update({ show_feedback_to_guests: false });
  const guest = await bulk(request.agent(app), { photo_ids: [photoIds[0]], rating: 4 }).expect(200);
  expect(guest.body.results[0]).not.toHaveProperty('average_rating');
  expect(guest.body.results[0]).not.toHaveProperty('total_ratings');

  const clientToken = jwt.sign({ eventId, eventSlug: SLUG, type: 'gallery', accessLevel: 'client', jti: randomUUID() },
    process.env.JWT_SECRET, { issuer: 'picpeak-auth', expiresIn: '1h' });
  const client = await request(app).post(`/api/gallery/${SLUG}/feedback/bulk`)
    .set('Authorization', `Bearer ${clientToken}`).send({ photo_ids: [photoIds[1]], rating: 2 }).expect(200);
  expect(client.body.results[0]).toEqual(expect.objectContaining({ photo_id: photoIds[1], average_rating: 2, total_ratings: 1 }));
});

test('a selection larger than the remaining budget rates nothing and spends nothing', async () => {
  const client = request.agent(app);
  await bulk(client, { photo_ids: photoIds.slice(0, 3), rating: 4 }).expect(200);
  const res = await bulk(client, { photo_ids: photoIds, rating: 2 }).expect(429);
  // Same answer as the single route gives at its limit.
  expect(res.body).toEqual({ error: 'Too many requests', retryAfter: 3600 });
  expect(res.headers['retry-after']).toBe('3600');
  expect(await ratings()).toEqual(Object.fromEntries(photoIds.slice(0, 3).map(id => [id, 4])));
  expect(await unitsSpent()).toEqual([3]);
  // What is left is still spendable, and shared with the single route.
  await bulk(client, { photo_ids: photoIds.slice(0, 2), rating: 2 }).expect(200);
  await single(client, photoIds[3], 5).expect(429);
});

test('a photo of another gallery or one hidden from the viewer is refused and costs nothing', async () => {
  const res = await bulk(request.agent(app), { photo_ids: [photoIds[0], foreignPhotoId, hiddenPhotoId], rating: 5 }).expect(200);
  expect(res.body.results).toEqual([
    expect.objectContaining({ photo_id: photoIds[0], success: true }),
    { photo_id: foreignPhotoId, success: false, error: 'Photo not found' },
    { photo_id: hiddenPhotoId, success: false, error: 'Photo not found' },
  ]);
  expect(await ratings()).toEqual({ [photoIds[0]]: 5 });
  expect(await unitsSpent()).toEqual([1]);
});

test('a photo in the trash is refused and costs nothing', async () => {
  const trashed = await insertPhoto(eventId, 'trashed.jpg', {
    deleted_at: new Date().toISOString(), purge_after: new Date(Date.now() + 86400000).toISOString(),
  });
  const res = await bulk(request.agent(app), { photo_ids: [photoIds[0], trashed], rating: 5 }).expect(200);
  expect(res.body.results).toEqual([
    expect.objectContaining({ photo_id: photoIds[0], success: true }),
    { photo_id: trashed, success: false, error: 'Photo not found' },
  ]);
  expect(await ratings()).toEqual({ [photoIds[0]]: 5 });
  expect(await unitsSpent()).toEqual([1]);
});

// The gallery list leaves out a photo the worker has not finished or failed
// on (wherePhotoProcessed); by id the feedback routes must not reach it either.
describe('a photo still pending, processing or failed', () => {
  let unfinished;
  beforeAll(async () => {
    unfinished = [
      await insertPhoto(eventId, 'processing.jpg', { processing_status: 'processing' }),
      await insertPhoto(eventId, 'failed.jpg', { processing_status: 'failed' }),
      await insertPhoto(eventId, 'pending.jpg', { processing_status: 'pending' }),
    ];
  });

  test('is refused by the bulk route and costs nothing', async () => {
    const res = await bulk(request.agent(app), { photo_ids: [photoIds[0], ...unfinished], rating: 5 }).expect(200);
    expect(res.body.results).toEqual([
      expect.objectContaining({ photo_id: photoIds[0], success: true }),
      ...unfinished.map(id => ({ photo_id: id, success: false, error: 'Photo not found' })),
    ]);
    expect(await ratings()).toEqual({ [photoIds[0]]: 5 });
    expect(await unitsSpent()).toEqual([1]);
  });

  test('is a 404 on the single routes, as a hidden photo is', async () => {
    const client = request.agent(app);
    for (const id of unfinished) {
      await single(client, id, 4).expect(404);
      await client.post(`/api/gallery/${SLUG}/photos/${id}/feedback`).set('Authorization', `Bearer ${token}`)
        .send({ feedback_type: 'like' }).expect(404);
      await client.get(`/api/gallery/${SLUG}/photos/${id}/feedback`).set('Authorization', `Bearer ${token}`).expect(404);
    }
    const { n } = await db('photo_feedback').whereIn('photo_id', unfinished).count('id as n').first();
    expect(Number(n)).toBe(0);
    // A finished photo still takes the same requests.
    await single(client, photoIds[1], 4).expect(200);
    await client.get(`/api/gallery/${SLUG}/photos/${photoIds[1]}/feedback`).set('Authorization', `Bearer ${token}`).expect(200);
  });
});

test('a repeated id is rated and charged once', async () => {
  const res = await bulk(request.agent(app), { photo_ids: [photoIds[0], photoIds[0]], rating: 3 }).expect(200);
  expect(res.body.results).toHaveLength(1);
  expect(await unitsSpent()).toEqual([1]);
});

test('rating 0 clears, as on the single route', async () => {
  const client = request.agent(app);
  await bulk(client, { photo_ids: photoIds.slice(0, 2), rating: 4 }).expect(200);
  const res = await bulk(client, { photo_ids: photoIds.slice(0, 2), rating: 0 }).expect(200);
  expect(res.body.results.every(r => r.success && r.removed)).toBe(true);
  expect(await ratings()).toEqual({});
});

test('refuses more ids than the cap, and malformed bodies', async () => {
  const client = request.agent(app);
  await bulk(client, { photo_ids: Array.from({ length: 201 }, (_, i) => i + 1), rating: 3 }).expect(400);
  await bulk(client, { photo_ids: [], rating: 3 }).expect(400);
  await bulk(client, { photo_ids: [photoIds[0], 'abc'], rating: 3 }).expect(400);
  await bulk(client, { photo_ids: [photoIds[0]], rating: 6 }).expect(400);
  await bulk(client, { photo_ids: [photoIds[0]] }).expect(400);
  expect(await ratings()).toEqual({});
  expect(await unitsSpent()).toEqual([]);
});

test('the single route\'s gallery checks apply', async () => {
  const client = request.agent(app);
  await client.post(`/api/gallery/${SLUG}/feedback/bulk`).send({ photo_ids: photoIds, rating: 3 }).expect(401);

  await db('event_feedback_settings').where({ event_id: eventId }).update({ allow_ratings: false });
  const off = await bulk(client, { photo_ids: [photoIds[0]], rating: 3 }).expect(403);
  expect(off.body.error).toBe('rating feedback is not enabled');

  await db('event_feedback_settings').where({ event_id: eventId }).update({ allow_ratings: true, require_name_email: true });
  const anonymous = await bulk(client, { photo_ids: [photoIds[0]], rating: 3 }).expect(400);
  expect(anonymous.body.error).toBe('Guest information required');
  await bulk(client, { photo_ids: [photoIds[0]], rating: 3, guest_name: 'Ada', guest_email: 'ada@example.test' }).expect(200);
  expect(await unitsSpent()).toEqual([1]);
});
