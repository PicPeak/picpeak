/**
 * The admin chunked upload and the limits the batch upload enforces.
 *
 * Files above the batch size go through chunked upload, and its /complete
 * step never checked the event's photo cap or the category scope that
 * POST /:eventId/upload applies. Both are now checked before the chunks are
 * merged, so a refused upload writes nothing.
 */

const mockCompleteUpload = jest.fn();
const mockAbortUpload = jest.fn(async () => undefined);
jest.mock('../../src/services/chunkedUploadService', () => ({
  ...jest.requireActual('../../src/services/chunkedUploadService'),
  completeUpload: (...args) => mockCompleteUpload(...args),
  abortUpload: (...args) => mockAbortUpload(...args),
}));

const mockProcessUploadedPhotos = jest.fn(async () => [{ id: 1 }]);
jest.mock('../../src/services/photoProcessor', () => ({
  ...jest.requireActual('../../src/services/photoProcessor'),
  processUploadedPhotos: (...args) => mockProcessUploadedPhotos(...args),
}));

const request = require('supertest');
const express = require('express');
const { bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken } = require('../integration/helpers/crmDb');

describe('admin chunked upload /complete limits', () => {
  let db; let cleanup; let app; let token;
  let seq = 0;

  const unwrap = (rows) => (typeof rows[0] === 'object' && rows[0] !== null ? rows[0].id : rows[0]);

  const createEvent = async (extra = {}) => {
    seq += 1;
    const slug = `chunked-limits-${seq}`;
    return unwrap(await db('events').insert({
      slug,
      event_type: 'wedding',
      event_name: `Chunked ${seq}`,
      event_date: '2026-08-01',
      host_email: 'host@example.com',
      admin_email: 'admin@example.com',
      password_hash: 'x',
      share_link: `/gallery/${slug}/share`,
      expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
      is_active: 1,
      is_archived: 0,
      is_draft: 0,
      created_at: new Date().toISOString(),
      ...extra,
    }).returning('id'));
  };

  const complete = (eventId, body = {}) => request(app)
    .post(`/api/admin/photos/${eventId}/chunked-upload/upload-abc/complete`)
    .set('Authorization', `Bearer ${token}`)
    .send(body);

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    const { adminId } = await seedMinimal(db);
    await assignAdminRole(db, adminId, 'super_admin');
    token = mintAdminToken(adminId);
    app = express();
    app.use(express.json());
    app.use('/api/admin/photos', require('../../src/routes/adminPhotos'));
  }, 180000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  beforeEach(() => {
    jest.clearAllMocks();
    mockCompleteUpload.mockResolvedValue({
      filename: 'big.jpg', mimeType: 'image/jpeg', size: 3, path: '/tmp/not-used', tempDir: '/tmp/not-used-dir',
    });
  });

  it('refuses to complete an upload into an event at its photo cap, and merges nothing', async () => {
    const eventId = await createEvent({ photo_cap: 1 });
    await db('photos').insert({
      event_id: eventId, filename: 'x.jpg', path: 'x/x.jpg', type: 'individual', uploaded_at: new Date().toISOString(),
    });

    const res = await complete(eventId);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/photo cap/i);
    expect(mockCompleteUpload).not.toHaveBeenCalled();
    expect(mockAbortUpload).toHaveBeenCalledWith('upload-abc');
  });

  it('refuses another event\'s category, and merges nothing', async () => {
    const eventId = await createEvent();
    const otherEventId = await createEvent();
    const foreign = unwrap(await db('photo_categories').insert({
      name: 'Foreign', slug: `foreign-chunked-${otherEventId}`, event_id: otherEventId, is_global: false,
    }).returning('id'));

    const res = await complete(eventId, { category_id: String(foreign) });

    expect(res.status).toBe(400);
    expect(mockCompleteUpload).not.toHaveBeenCalled();
  });

  it('completes an upload with its own category below the cap', async () => {
    const eventId = await createEvent({ photo_cap: 5 });
    const own = unwrap(await db('photo_categories').insert({
      name: 'Own', slug: `own-chunked-${eventId}`, event_id: eventId, is_global: false,
    }).returning('id'));

    const res = await complete(eventId, { category_id: String(own) });

    expect(res.status).toBe(200);
    expect(mockCompleteUpload).toHaveBeenCalledWith('upload-abc');
    expect(mockProcessUploadedPhotos).toHaveBeenCalled();
  });
});
