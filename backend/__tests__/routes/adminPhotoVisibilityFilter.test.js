process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'photo-visibility-regression-secret-at-least-32-characters';

const express = require('express');
const request = require('supertest');
const { bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken } = require('../integration/helpers/crmDb');

let db, cleanup, app, adminId, token, eventId, foreignEventId, categoryId;
let visibleId, defaultId, hiddenId, otherHiddenId;

const auth = (req) => req.set('Authorization', `Bearer ${token}`);
const read = (query = {}) => auth(request(app).get(`/api/admin/photos/${eventId}/photos`)).query(query);
const list = async (query) => {
  const res = await read(query);
  expect(res.status).toBe(200);
  return res.body.photos;
};
const addPhoto = async (filename, visibility, extra = {}) => {
  const [row] = await db('photos').insert({
    event_id: eventId, filename, path: `visibility/${filename}`, type: 'individual',
    ...(visibility === undefined ? {} : { visibility }), uploaded_at: '2026-10-01T00:00:00Z', ...extra,
  }).returning('id');
  return row.id ?? row;
};

beforeAll(async () => {
  ({ db, cleanup } = await bootCrmDb());
  ({ adminId } = await seedMinimal(db));
  await assignAdminRole(db, adminId, 'super_admin');
  token = mintAdminToken(adminId);
  const event = (slug) => ({
    slug, event_name: slug, event_type: 'wedding', password_hash: 'unused',
    host_email: 'sample@example.test', admin_email: 'admin@example.test',
    share_link: `/gallery/${slug}`, created_by: adminId,
  });
  const [own] = await db('events').insert(event('visibility-test')).returning('id');
  eventId = own.id ?? own;
  const [other] = await db('events').insert(event('visibility-other')).returning('id');
  foreignEventId = other.id ?? other;
  const [category] = await db('photo_categories').insert({ event_id: eventId, name: 'Ceremony', slug: 'ceremony' }).returning('id');
  categoryId = category.id ?? category;
  app = express(); app.use(express.json());
  app.use('/api/admin/photos', require('../../src/routes/adminPhotos'));
}, 120000);

beforeEach(async () => {
  await db('photos').whereIn('event_id', [eventId, foreignEventId]).del();
  visibleId = await addPhoto('visible.jpg', 'visible', { category_id: categoryId });
  defaultId = await addPhoto('default.jpg', undefined, { category_id: categoryId });
  hiddenId = await addPhoto('hidden.jpg', 'hidden', { category_id: categoryId, like_count: 2, average_rating: 4 });
  otherHiddenId = await addPhoto('hidden-other.jpg', 'hidden', { like_count: 9 });
  await addPhoto('trashed.jpg', 'hidden', { deleted_at: new Date().toISOString() });
  await addPhoto('foreign.jpg', 'hidden', { event_id: foreignEventId });
});
afterAll(async () => { if (cleanup) await cleanup(); });

it('keeps All Photos as the default, excluding the trash and other events', async () => {
  const expected = [otherHiddenId, hiddenId, defaultId, visibleId];
  expect((await list()).map((p) => p.id)).toEqual(expected);
  expect((await list({ visibility: 'all' })).map((p) => p.id)).toEqual(expected);
});

it('returns only hidden photos when Hidden Photos is selected', async () => {
  const photos = await list({ visibility: 'hidden' });
  expect(photos.map((p) => p.id)).toEqual([otherHiddenId, hiddenId]);
  expect(photos.every((p) => p.visibility === 'hidden')).toBe(true);
});

it('includes photos with the default visibility in Visible Photos', async () => {
  const photos = await list({ visibility: 'visible' });
  expect(photos.map((p) => p.id)).toEqual([defaultId, visibleId]);
  expect(photos.every((p) => p.visibility === 'visible')).toBe(true);
});

it('combines visibility with search, category, feedback and name ordering', async () => {
  await addPhoto('hidden-10.jpg', 'hidden', { category_id: categoryId, like_count: 3, average_rating: 5 });
  await addPhoto('hidden-2.jpg', 'hidden', { category_id: categoryId, like_count: 1, average_rating: 4 });
  const query = { visibility: 'hidden', category_id: categoryId, search: 'hidden-', has_likes: 'true', min_rating: 3, sort: 'name' };
  expect((await list({ ...query, order: 'asc' })).map((p) => p.filename)).toEqual(['hidden-2.jpg', 'hidden-10.jpg']);
  expect((await list({ ...query, order: 'desc' })).map((p) => p.filename)).toEqual(['hidden-10.jpg', 'hidden-2.jpg']);
});

it('keeps visibility grouped with the other filters', async () => {
  expect((await list({ visibility: 'visible', search: 'visible', category_id: categoryId })).map((p) => p.id)).toEqual([visibleId]);
  expect(await list({ visibility: 'visible', has_likes: 'true' })).toEqual([]);
});

it('filters the full gallery on the server', async () => {
  const rows = Array.from({ length: 285 }, (_, i) => ({
    event_id: eventId, filename: `batch-${i}.jpg`, path: `visibility/batch-${i}.jpg`,
    type: 'individual', visibility: ['hidden', 'visible', 'visible'][i % 3],
  }));
  await db.batchInsert('photos', rows, 100);
  const photos = await list({ visibility: 'hidden', search: 'batch-', sort: 'name', order: 'asc' });
  expect(photos).toHaveLength(95);
  expect(photos.every((p) => p.visibility === 'hidden')).toBe(true);
  expect(photos[0].filename).toBe('batch-0.jpg');
  expect(photos[94].filename).toBe('batch-282.jpg');
});

it('bulk-deletes the filtered hidden photos while leaving visible photos alone', async () => {
  const ids = (await list({ visibility: 'hidden' })).map((p) => p.id);
  const response = await auth(request(app).post(`/api/admin/photos/${eventId}/photos/bulk-delete`)).send({ photoIds: ids });
  expect(response.status).toBe(200);
  expect(response.body).toMatchObject({ trashed: 2, deleted: 0, failed: [] });
  expect(await list({ visibility: 'hidden' })).toEqual([]);
  expect((await list()).map((p) => p.id)).toEqual([defaultId, visibleId]);
});

it('does not grant delete permissions to an admin who can only view photos', async () => {
  await assignAdminRole(db, adminId, 'viewer');
  require('../../src/middleware/permissions').clearPermissionCache();
  try {
    expect((await read({ visibility: 'hidden' })).status).toBe(200);
    const response = await auth(request(app).post(`/api/admin/photos/${eventId}/photos/bulk-delete`)).send({ photoIds: [hiddenId] });
    expect(response.status).toBe(403);
    expect((await db('photos').where({ id: hiddenId }).first()).deleted_at).toBeNull();
  } finally {
    await assignAdminRole(db, adminId, 'super_admin');
    require('../../src/middleware/permissions').clearPermissionCache();
  }
});

it('still requires an authenticated admin', async () => {
  expect((await request(app).get(`/api/admin/photos/${eventId}/photos?visibility=hidden`)).status).toBe(401);
});
