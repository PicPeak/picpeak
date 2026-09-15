/**
 * Who may change the thumbnail settings and start a regeneration.
 *
 * The settings are instance-wide and the regenerate endpoints rebuild every
 * gallery's renditions, yet all three only needed photos.edit, which the
 * editor and team_photographer roles hold. A scoped regeneration took any
 * eventId, and nothing stopped a second whole-library run from starting while
 * the first was still going.
 *
 * Real auth and permissions; only the image work is mocked, and held open
 * where a test needs a job to still be running.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const express = require('express');
const request = require('supertest');

describe('thumbnail settings and regeneration permissions', () => {
  let tmpDir; let db; let cleanup; let app; let logInfo;
  const tok = {};
  const id = {};
  const hold = { promise: null };

  const as = (req, who) => req.set('Authorization', `Bearer ${tok[who]}`);

  beforeAll(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'picpeak-thumbperm-'));
    process.env.NODE_ENV = 'test';
    process.env.TEST_DATABASE_PATH = path.join(tmpDir, 'data', 'test.db');
    process.env.STORAGE_PATH = path.join(tmpDir, 'storage');
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'thumbperm-test-secret';
    await fs.promises.mkdir(path.dirname(process.env.TEST_DATABASE_PATH), { recursive: true });
    await fs.promises.mkdir(process.env.STORAGE_PATH, { recursive: true });

    jest.resetModules();
    jest.doMock('../../src/services/storage', () => {
      const instance = { delete: jest.fn().mockResolvedValue(undefined) };
      return { getStorage: () => instance };
    });
    jest.doMock('../../src/services/imageProcessor', () => ({
      ensureThumbnail: jest.fn(async () => { await hold.promise; return 'thumbnails/thumb.jpg'; }),
      ensurePreviewImage: jest.fn(async () => { await hold.promise; return 'previews/p.jpg'; }),
      deleteThumbnailTiers: jest.fn().mockResolvedValue(undefined),
      deletePreviewTiers: jest.fn().mockResolvedValue(undefined),
    }));
    logInfo = jest.spyOn(require('../../src/utils/logger'), 'info');

    const helpers = require('../integration/helpers/crmDb');
    ({ db, cleanup } = await helpers.bootCrmDb());

    const mkAdmin = async (name, roleName) => {
      const rows = await db('admin_users').insert({
        username: `thumbperm-${name}`, email: `thumbperm-${name}@example.com`,
        password_hash: 'x', must_change_password: false, created_at: new Date().toISOString(),
      }).returning('id');
      const adminId = rows[0]?.id ?? rows[0];
      await helpers.assignAdminRole(db, adminId, roleName);
      tok[name] = helpers.mintAdminToken(adminId);
      return adminId;
    };
    id.team = await mkAdmin('team', 'team_photographer');
    id.solo = await mkAdmin('solo', 'solo_photographer');

    const mkEvent = async (slug, createdBy) => {
      const rows = await db('events').insert({
        slug, event_type: 'wedding', event_name: slug, event_date: '2026-01-01',
        host_email: 'h@example.com', admin_email: 'a@example.com', password_hash: 'x',
        share_link: `${slug}-share`, expires_at: new Date(Date.now() + 864e5).toISOString(),
        created_by: createdBy, created_at: new Date().toISOString(),
      }).returning('id');
      const eventId = rows[0]?.id ?? rows[0];
      await db('photos').insert({
        event_id: eventId, filename: `${slug}.jpg`, path: `${slug}/shot.jpg`, type: 'individual',
      });
      return eventId;
    };
    id.teamEvent = await mkEvent('team-gallery', id.team);
    id.foreignEvent = await mkEvent('solo-gallery', id.solo);

    app = express();
    app.use(express.json());
    app.use('/api/admin/thumbnails', require('../../src/routes/adminThumbnails'));
  }, 180000);

  afterAll(async () => {
    if (cleanup) await cleanup();
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  beforeEach(() => {
    hold.promise = null;
    logInfo.mockClear();
  });

  const drain = async (pattern = /regeneration complete/) => {
    const deadline = Date.now() + 10000;
    const done = () => logInfo.mock.calls.some((c) => pattern.test(String(c[0])));
    while (!done() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(done()).toBe(true);
  };

  it('needs settings.edit to change the instance-wide thumbnail settings', async () => {
    const team = await as(request(app).put('/api/admin/thumbnails/settings'), 'team').send({ width: 320 });
    expect(team.status).toBe(403);

    const solo = await as(request(app).put('/api/admin/thumbnails/settings'), 'solo').send({ width: 320 });
    expect(solo.status).toBe(200);
  });

  it('lets photos.edit regenerate its own event, but not another owner\'s or the whole library', async () => {
    const library = await as(request(app).post('/api/admin/thumbnails/regenerate'), 'team').send({});
    expect(library.status).toBe(403);

    const foreign = await as(request(app).post('/api/admin/thumbnails/regenerate'), 'team')
      .send({ eventId: id.foreignEvent });
    expect(foreign.status).toBe(403);

    const foreignPreviews = await as(request(app).post('/api/admin/thumbnails/regenerate-previews'), 'team')
      .send({ eventId: id.foreignEvent });
    expect(foreignPreviews.status).toBe(403);

    const own = await as(request(app).post('/api/admin/thumbnails/regenerate'), 'team')
      .send({ eventId: id.teamEvent });
    expect(own.status).toBe(200);
    expect(own.body.count).toBe(1);
    await drain();
  });

  it('refuses a second regeneration while one is still running, and allows one after it finished', async () => {
    let release;
    hold.promise = new Promise((resolve) => { release = resolve; });

    const first = await as(request(app).post('/api/admin/thumbnails/regenerate'), 'solo').send({});
    expect(first.status).toBe(200);

    const second = await as(request(app).post('/api/admin/thumbnails/regenerate'), 'solo').send({});
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('REGENERATION_RUNNING');

    release();
    await drain();
    hold.promise = null;
    logInfo.mockClear();

    const third = await as(request(app).post('/api/admin/thumbnails/regenerate'), 'solo').send({});
    expect(third.status).toBe(200);
    await drain();
  });

  it('holds preview regeneration to the same one-at-a-time rule', async () => {
    let release;
    hold.promise = new Promise((resolve) => { release = resolve; });

    const first = await as(request(app).post('/api/admin/thumbnails/regenerate-previews'), 'solo').send({});
    expect(first.status).toBe(200);
    const second = await as(request(app).post('/api/admin/thumbnails/regenerate-previews'), 'solo').send({});
    expect(second.status).toBe(409);

    release();
    await drain(/Preview regeneration complete/);
  });
});
