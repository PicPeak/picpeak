/**
 * A chunked upload belongs to the admin who initialised it, for the event it
 * was initialised for.
 *
 * Every operation after init is addressed by the opaque upload id, and
 * requireEventOwnership can only prove access to the :eventId in the URL. So
 * a scoped admin who learned another admin's upload id could pair it with an
 * event of their own and read its progress, overwrite its chunks, abort it,
 * or complete the other admin's bytes into their own event. The service now
 * checks the stored event and admin on every call and answers 404 — the same
 * as an unknown id — on a mismatch.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.STORAGE_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-chunk-own-'));

const mockProcessUploadedPhotos = jest.fn(async () => [{ id: 1 }]);
jest.mock('../../src/services/photoProcessor', () => ({
  ...jest.requireActual('../../src/services/photoProcessor'),
  processUploadedPhotos: (...args) => mockProcessUploadedPhotos(...args),
}));

const request = require('supertest');
const express = require('express');
const bcrypt = require('bcrypt');
const { bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken } = require('../integration/helpers/crmDb');

describe('admin chunked upload ownership', () => {
  let db; let cleanup; let app;
  let ownerToken; let otherToken; let superToken;
  let ownerEvent; let ownerSecondEvent; let otherEvent;
  let uploadId;
  let seq = 0;

  const unwrap = (rows) => (typeof rows[0] === 'object' && rows[0] !== null ? rows[0].id : rows[0]);

  const createAdmin = async (username, roleName) => {
    const id = unwrap(await db('admin_users').insert({
      username,
      email: `${username}@example.com`,
      password_hash: await bcrypt.hash('pw', 4),
      is_active: 1,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).returning('id'));
    await assignAdminRole(db, id, roleName);
    return id;
  };

  const createEvent = async (createdBy) => {
    seq += 1;
    const slug = `chunk-own-${seq}`;
    return unwrap(await db('events').insert({
      slug,
      event_type: 'wedding',
      event_name: `Owned ${seq}`,
      event_date: '2026-08-01',
      host_email: 'host@example.com',
      admin_email: 'admin@example.com',
      password_hash: 'x',
      share_link: `/gallery/${slug}/share`,
      expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
      is_active: 1,
      is_archived: 0,
      is_draft: 0,
      created_by: createdBy,
      created_at: new Date().toISOString(),
    }).returning('id'));
  };

  const init = (token, eventId) => request(app)
    .post(`/api/admin/photos/${eventId}/chunked-upload/init`)
    .set('Authorization', `Bearer ${token}`)
    .send({ filename: 'shot.jpg', fileSize: 3, totalChunks: 1 });

  const status = (token, eventId, id) => request(app)
    .get(`/api/admin/photos/${eventId}/chunked-upload/${id}/status`)
    .set('Authorization', `Bearer ${token}`);

  const chunk = (token, eventId, id) => request(app)
    .post(`/api/admin/photos/${eventId}/chunked-upload/${id}/chunk/0`)
    .set('Authorization', `Bearer ${token}`)
    .set('Content-Type', 'application/octet-stream')
    .send(Buffer.from('abc'));

  const complete = (token, eventId, id) => request(app)
    .post(`/api/admin/photos/${eventId}/chunked-upload/${id}/complete`)
    .set('Authorization', `Bearer ${token}`)
    .send({});

  const abort = (token, eventId, id) => request(app)
    .delete(`/api/admin/photos/${eventId}/chunked-upload/${id}`)
    .set('Authorization', `Bearer ${token}`);

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    const { adminId } = await seedMinimal(db);
    await assignAdminRole(db, adminId, 'super_admin');
    superToken = mintAdminToken(adminId);

    // Two scoped admins, each owning their own event. The `admin` role holds
    // photos.upload and photos.delete but not events.manage_all, so
    // requireEventOwnership lets each one reach only their own events.
    const ownerId = await createAdmin('chunk-owner', 'admin');
    const otherId = await createAdmin('chunk-other', 'admin');
    ownerToken = mintAdminToken(ownerId);
    otherToken = mintAdminToken(otherId);
    ownerEvent = await createEvent(ownerId);
    ownerSecondEvent = await createEvent(ownerId);
    otherEvent = await createEvent(otherId);

    app = express();
    app.use(express.json());
    app.use('/api/admin/photos', require('../../src/routes/adminPhotos'));
  }, 180000);

  afterAll(async () => {
    if (cleanup) await cleanup();
    require('../../src/services/chunkedUploadService').stop();
    await fs.promises.rm(process.env.STORAGE_PATH, { recursive: true, force: true }).catch(() => {});
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    const res = await init(ownerToken, ownerEvent);
    expect(res.status).toBe(200);
    uploadId = res.body.uploadId;
  });

  describe('another admin pairing the leaked id with an event of their own', () => {
    it('cannot read its status', async () => {
      const res = await status(otherToken, otherEvent, uploadId);
      expect(res.status).toBe(404);
    });

    it('cannot write a chunk into it', async () => {
      const res = await chunk(otherToken, otherEvent, uploadId);
      expect(res.status).toBe(404);
      // Nothing landed: the owner's upload still has no chunks.
      expect((await status(ownerToken, ownerEvent, uploadId)).body.receivedChunks).toBe(0);
    });

    it('cannot complete it into their event', async () => {
      await chunk(ownerToken, ownerEvent, uploadId);
      const res = await complete(otherToken, otherEvent, uploadId);
      expect(res.status).toBe(404);
      expect(mockProcessUploadedPhotos).not.toHaveBeenCalled();
      // Still there for its owner.
      expect((await status(ownerToken, ownerEvent, uploadId)).status).toBe(200);
    });

    it('cannot abort it', async () => {
      const res = await abort(otherToken, otherEvent, uploadId);
      expect(res.status).toBe(404);
      expect((await status(ownerToken, ownerEvent, uploadId)).status).toBe(200);
    });
  });

  it('is bound to the event it was initialised for, even for its owner', async () => {
    expect((await status(ownerToken, ownerSecondEvent, uploadId)).status).toBe(404);
    expect((await chunk(ownerToken, ownerSecondEvent, uploadId)).status).toBe(404);
    expect((await complete(ownerToken, ownerSecondEvent, uploadId)).status).toBe(404);
    expect((await abort(ownerToken, ownerSecondEvent, uploadId)).status).toBe(404);
  });

  it('is bound to the admin who initialised it, super admin included', async () => {
    expect((await status(superToken, ownerEvent, uploadId)).status).toBe(404);
    expect((await complete(superToken, ownerEvent, uploadId)).status).toBe(404);
  });

  it('lets its owner run the whole flow, and processes under the stored event', async () => {
    expect((await status(ownerToken, ownerEvent, uploadId)).status).toBe(200);
    expect((await chunk(ownerToken, ownerEvent, uploadId)).status).toBe(200);
    const res = await complete(ownerToken, ownerEvent, uploadId);
    expect(res.status).toBe(200);
    expect(mockProcessUploadedPhotos).toHaveBeenCalledTimes(1);
    expect(mockProcessUploadedPhotos.mock.calls[0][1]).toBe(ownerEvent);
  });

  it('lets its owner abort it', async () => {
    expect((await abort(ownerToken, ownerEvent, uploadId)).status).toBe(200);
    expect((await status(ownerToken, ownerEvent, uploadId)).status).toBe(404);
  });
});
