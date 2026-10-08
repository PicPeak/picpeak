/**
 * External folders in one step: a gallery can be created pointing at a folder
 * and import it straight away, and Rescan imports the stored folder without
 * the admin picking it again.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const express = require('express');
const request = require('supertest');

describe('external folder in one step', () => {
  let tmpDir; let db; let app; let mediaRoot; let createEvent; let actor; let mockHasUpload = true;

  const touch = async (rel) => {
    const full = path.join(mediaRoot, rel);
    await fs.promises.mkdir(path.dirname(full), { recursive: true });
    await fs.promises.writeFile(full, 'not-a-real-jpeg');
  };
  const waitFor = async (fn, ms = 5000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await fn()) return true;
      await new Promise((r) => setTimeout(r, 25));
    }
    return false;
  };

  beforeAll(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'picpeak-ext1step-'));
    mediaRoot = path.join(tmpDir, 'media');
    await fs.promises.mkdir(mediaRoot, { recursive: true });

    process.env.NODE_ENV = 'test';
    process.env.TEST_DATABASE_PATH = path.join(tmpDir, 'data', 'db.sqlite');
    await fs.promises.mkdir(path.dirname(process.env.TEST_DATABASE_PATH), { recursive: true });
    process.env.STORAGE_PATH = path.join(tmpDir, 'storage');
    process.env.EXTERNAL_MEDIA_ROOT = mediaRoot;
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'ext1step-secret';

    jest.resetModules();
    jest.doMock('../../src/middleware/auth', () => ({
      adminAuth: (req, _res, next) => { req.admin = { id: 1, username: 'tester', roleName: 'admin' }; next(); },
    }));
    jest.doMock('../../src/middleware/permissions', () => ({
      requirePermission: () => (_req, _res, next) => next(),
      userHasAllPermissions: jest.fn(async () => mockHasUpload),
      roleEventScope: jest.fn(async () => null),
    }));
    jest.doMock('../../src/middleware/ownership', () => ({
      requireEventOwnership: (_req, _res, next) => next(),
    }));
    jest.doMock('sharp', () => () => ({ metadata: async () => ({ width: 100, height: 200 }) }));
    jest.doMock('../../src/services/imageProcessor', () => ({
      generateThumbnail: jest.fn(async () => 'thumbnails/mock.jpg'),
      ensureThumbnail: jest.fn(),
    }));
    jest.doMock('../../src/utils/logger', () => ({
      debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(),
    }));

    const crmDb = require('./helpers/crmDb');
    ({ db } = await crmDb.bootCrmDb());
    // A real admin row: events.created_by is a foreign key on PostgreSQL.
    const { adminId } = await crmDb.seedMinimal(db);
    await crmDb.assignAdminRole(db, adminId);
    actor = { id: Number(adminId), username: 'tester' };
    ({ createEvent } = require('../../src/services/eventCreationService'));

    app = express();
    app.use(express.json());
    app.use('/api/admin/external-media', require('../../src/routes/adminExternalMedia'));
  }, 180000);

  afterAll(async () => {
    if (db) await db.destroy?.();
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  const base = (name) => ({
    event_type: 'wedding', event_name: name, event_date: '2026-06-14',
    customer_email: 'c@example.com', customer_name: 'C', admin_email: 'a@example.com',
    require_password: false, expiration_days: 30,
  });

  it('creates a gallery on a folder and imports it right away', async () => {
    await touch('Wedding/a.jpg');
    await touch('Wedding/b.jpg');
    const created = await createEvent({
      ...base('one-step'), source_mode: 'reference', external_path: 'Wedding', external_watch: true, import_now: true,
    }, { actor });

    expect(created.import_started).toBe(true);
    const row = await db('events').where({ id: created.id }).first();
    expect(row.source_mode).toBe('reference');
    expect(row.external_path).toBe('Wedding');
    expect(Boolean(row.external_watch)).toBe(true);
    expect(await waitFor(async () => (await db('photos').where({ event_id: created.id })).length === 2)).toBe(true);
  });

  it('rescans the stored folder when no path is sent, and reports when it finished', async () => {
    await fs.promises.mkdir(path.join(mediaRoot, 'Later'), { recursive: true });
    const created = await createEvent({ ...base('rescan'), source_mode: 'reference', external_path: 'Later' }, { actor });
    await touch('Later/one.jpg');
    const res = await request(app).post(`/api/admin/external-media/events/${created.id}/import-external`).send({});
    expect(res.status).toBe(200);
    expect(res.body.imported).toBe(1);

    const status = await request(app).get(`/api/admin/external-media/events/${created.id}/status`);
    expect(status.status).toBe(200);
    expect(status.body.is_running).toBe(false);
    expect(typeof status.body.finished_at).toBe('string');
  });

  it('refuses a rescan for a gallery without a folder', async () => {
    const created = await createEvent(base('managed'), { actor });
    const res = await request(app).post(`/api/admin/external-media/events/${created.id}/import-external`).send({});
    expect(res.status).toBe(400);
  });

  it('rejects a folder outside the media root or one that does not exist', async () => {
    await expect(createEvent({ ...base('bad'), source_mode: 'reference', external_path: '../etc' }, { actor }))
      .rejects.toMatchObject({ statusCode: 400 });
    await expect(createEvent({ ...base('missing'), source_mode: 'reference', external_path: 'Nope' }, { actor }))
      .rejects.toMatchObject({ statusCode: 400 });
    // The media root itself is never one gallery's folder.
    for (const external_path of ['.', './', 'Wedding/..', '/']) {
      await expect(createEvent({ ...base('root'), source_mode: 'reference', external_path }, { actor }))
        .rejects.toMatchObject({ statusCode: 400, code: 'EXTERNAL_PATH_REQUIRED' });
    }
  });

  it('needs photos.upload to import or watch on create', async () => {
    await touch('Guarded/x.jpg');
    mockHasUpload = false;
    try {
      await expect(createEvent({ ...base('guarded'), source_mode: 'reference', external_path: 'Guarded', import_now: true }, { actor }))
        .rejects.toMatchObject({ statusCode: 403 });
      const plain = await createEvent({ ...base('guarded-plain'), source_mode: 'reference', external_path: 'Guarded' }, { actor });
      expect(plain.import_started).toBe(false);
    } finally {
      mockHasUpload = true;
    }
  });

  it('records a failed import so the Photos tab can say so', async () => {
    await fs.promises.mkdir(path.join(mediaRoot, 'Gone'), { recursive: true });
    const created = await createEvent({ ...base('gone'), source_mode: 'reference', external_path: 'Gone' }, { actor });
    await fs.promises.rm(path.join(mediaRoot, 'Gone'), { recursive: true, force: true });
    const res = await request(app).post(`/api/admin/external-media/events/${created.id}/import-external`).send({});
    expect(res.status).toBe(500);
    const status = await request(app).get(`/api/admin/external-media/events/${created.id}/status`);
    // A code, never the fs message: that quotes the absolute host path.
    expect(status.body.last_result).toEqual({ failed: true, error: 'folder_missing' });
    expect(JSON.stringify(status.body)).not.toContain(mediaRoot);
  });
});
