/**
 * Outage drills for graceful degradation. Real probes, real routes, a real
 * database: the storage directory really disappears. Only what a test cannot
 * safely do for real is simulated (a full disk, a database refusing queries,
 * CPU load). Runs on both engines; mail outages are in emailOutageRetry.test.js.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-drills-')), 'db.sqlite');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'degradation-drills-secret';

const express = require('express');
const fsp = require('fs/promises');
const cookieParser = require('cookie-parser');
const request = require('supertest');
const { bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken } = require('./helpers/crmDb');
const { decodeSettingValue } = require('../helpers/settingValue');

const GIB = 1024 ** 3;

describe('outage drills', () => {
  let db; let cleanup; let app; let token; let eventId; let health; let governor;

  const ticks = async (count) => { for (let i = 0; i < count; i += 1) await health.tick(); };
  const dependency = (name) => health.snapshot().dependencies[name];
  const capability = (name) => health.evaluate(name);
  const uploadAsAdmin = () => request(app).post(`/api/admin/events/${eventId}/chunked-upload/init`)
    .set('Authorization', `Bearer ${token}`)
    .send({ filename: 'a.jpg', fileSize: 1024, totalChunks: 1, mimeType: 'image/jpeg' });
  const status = () => request(app).get('/api/admin/system-health/status').set('Authorization', `Bearer ${token}`);

  function breakStorage() {
    // bootCrmDb gives the suite its own STORAGE_PATH.
    const storage = process.env.STORAGE_PATH;
    fs.renameSync(storage, `${storage}-gone`);
    return () => {
      // An upload let through in observe mode recreates the directory.
      fs.rmSync(storage, { recursive: true, force: true });
      fs.renameSync(`${storage}-gone`, storage);
    };
  }

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    const { adminId } = await seedMinimal(db);
    await assignAdminRole(db, adminId, 'super_admin');
    token = mintAdminToken(adminId);
    const inserted = await db('events').insert({
      slug: 'drill-gallery', event_type: 'wedding', event_name: 'Drill', event_date: '2026-05-29',
      host_email: 'host@example.com', admin_email: 'admin@example.com', password_hash: 'x',
      share_link: '/gallery/drill', share_token: 'drill-token',
      expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
      is_active: 1, is_archived: 0, is_draft: 0, created_by: adminId, created_at: new Date().toISOString(),
    }).returning('id');
    eventId = inserted[0]?.id ?? inserted[0];

    health = require('../../src/services/dependencyHealth');
    governor = require('../../src/services/loadGovernor');
    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/admin/events', require('../../src/routes/adminPhotos'));
    app.use('/api/admin/system-health', require('../../src/routes/adminSystemHealth'));
    app.use('/api/admin/settings', require('../../src/routes/adminSettings'));
    app.use('/api/gallery', require('../../src/routes/gallery'));
    // eslint-disable-next-line no-unused-vars
    app.use((err, req, res, next) => res.status(err.statusCode || err.status || 500).json({ error: err.message, code: err.code }));
  }, 120000);

  afterAll(async () => {
    await health.stop();
    if (cleanup) await cleanup();
  });

  beforeEach(async () => {
    await health.updateSettings({ enforcement: 'enforce', forcedOff: [] });
    await health.recheck();
  });

  afterEach(() => jest.restoreAllMocks());

  it('starts healthy on real probes', async () => {
    expect(dependency('database').state).toBe('healthy');
    expect(dependency('storage').state).toBe('healthy');
    expect(dependency('disk').metrics.freeBytes).toBeGreaterThan(0);
    expect(capability('uploads.new').available).toBe(true);
  });

  describe('storage disappears', () => {
    it('pauses uploads, then archives, and recovers only after a stable run', async () => {
      const restore = breakStorage();
      try {
        await ticks(2);
        expect(dependency('storage').state).toBe('degraded');
        expect(capability('uploads.new').available).toBe(false);
        // A missing directory also takes away the free-space reading, so
        // archives stop too. Merely slow storage keeps them: capabilities.test.js.
        expect(capability('downloads.archive').blockedBy).toEqual(['disk']);

        const refused = await uploadAsAdmin();
        expect(refused.status).toBe(503);
        expect(refused.body).toMatchObject({ code: 'CAPABILITY_UNAVAILABLE', capability: 'uploads.new' });

        await ticks(2);
        expect(dependency('storage').state).toBe('down');
        expect(capability('downloads.archive').blockedBy).toEqual(expect.arrayContaining(['storage', 'disk']));
      } finally {
        restore();
      }

      await ticks(7);
      expect(dependency('storage').state).toBe('down');
      await ticks(1);
      expect(dependency('storage').state).toBe('healthy');
      expect((await uploadAsAdmin()).status).not.toBe(503);
    });

    it('lets an admin who fixed it recover at once', async () => {
      const restore = breakStorage();
      await ticks(4).finally(restore);
      const res = await request(app).post('/api/admin/system-health/status/recheck').set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.dependencies.storage.state).toBe('healthy');
    });

    it('only logs in observe mode', async () => {
      await health.updateSettings({ enforcement: 'observe' });
      const restore = breakStorage();
      try {
        await ticks(4);
        expect(capability('uploads.new').available).toBe(false);
        expect((await uploadAsAdmin()).status).not.toBe(503);
      } finally {
        restore();
      }
    });
  });

  it('pauses uploads as the disk fills, and archives only near full', async () => {
    const statfs = jest.spyOn(fsp, 'statfs');
    statfs.mockResolvedValue({ bavail: 1.5 * GIB, bsize: 1, blocks: 20 * GIB });
    await ticks(2);
    expect(dependency('disk').state).toBe('degraded');
    expect(capability('uploads.new').available).toBe(false);
    expect(capability('downloads.archive').blockedBy).toEqual(['disk']);
    statfs.mockResolvedValue({ bavail: 0.2 * GIB, bsize: 1, blocks: 20 * GIB });
    await ticks(4);
    expect(dependency('disk').state).toBe('down');
  });

  it('keeps answering the admin with the database down, and keeps their settings', async () => {
    const { database } = health.probes;
    health.probes = { ...health.probes, database: async () => { throw new Error('connection refused'); } };
    await ticks(4).finally(() => { health.probes = { ...health.probes }; });
    const res = await status();
    health.probes = { ...health.probes, database };
    expect(res.status).toBe(200);
    expect(res.body.dependencies.database.state).toBe('down');
    expect(res.body.enforcement).toBe('enforce');
  });

  it('marks an unreachable face service down and leaves everything else alone', async () => {
    const faceSettings = require('../../src/services/faceSettings');
    const faceClient = require('../../src/services/faceClient');
    jest.spyOn(faceSettings, 'isFeatureEnabled').mockResolvedValue(true);
    jest.spyOn(faceClient, 'checkHealth').mockResolvedValue({ ok: false, reason: 'unreachable', error: 'ECONNREFUSED' });
    await ticks(4);
    expect(dependency('faceSidecar').state).toBe('down');
    expect(capability('uploads.new').available).toBe(true);
    expect(capability('downloads.archive').available).toBe(true);
  });

  it('steps background work down under sustained CPU load and back up', async () => {
    const hostMetrics = require('../../src/services/hostMetrics');
    const sample = jest.spyOn(hostMetrics, 'sample');
    sample.mockReturnValue({ cpuPercent: 95, memoryPercent: 40, eventLoopDelayMs: 1, cores: 2 });
    await ticks(3);
    expect(governor.workerLimit(2)).toBe(1);
    expect(governor.bulkDelayMs()).toBeGreaterThan(0);
    sample.mockReturnValue({ cpuPercent: 10, memoryPercent: 40, eventLoopDelayMs: 1, cores: 2 });
    await ticks(4);
    expect(governor.workerLimit(2)).toBe(2);
    expect(governor.bulkDelayMs()).toBe(0);
  });

  it('pauses archives when memory is critical, and photo workers with them', async () => {
    const hostMetrics = require('../../src/services/hostMetrics');
    jest.spyOn(hostMetrics, 'sample').mockReturnValue({ cpuPercent: 20, memoryPercent: 98, eventLoopDelayMs: 1, cores: 2 });
    await ticks(4);
    expect(dependency('load').state).toBe('down');
    expect(capability('downloads.archive').blockedBy).toEqual(['load']);
    expect(governor.workerLimit(2)).toBe(0);
  });

  describe('security with everything failing', () => {
    let restore;
    beforeEach(async () => {
      restore = breakStorage();
      await ticks(4);
      expect(capability('uploads.new').available).toBe(false);
    });
    afterEach(() => restore());

    it('refuses anonymous callers as usual and reveals no state', async () => {
      const results = await Promise.all([
        request(app).post(`/api/admin/events/${eventId}/chunked-upload/init`).send({}),
        request(app).post(`/api/gallery/${eventId}/chunked-upload/init`).send({}),
        request(app).get('/api/gallery/drill-gallery/download-all'),
        request(app).post('/api/gallery/drill-gallery/download-jobs').send({}),
        request(app).get('/api/gallery/drill-gallery/photos'),
        request(app).get('/api/admin/system-health/status'),
      ]);
      for (const res of results) {
        expect([401, 403]).toContain(res.status);
        expect(res.body.code).not.toBe('CAPABILITY_UNAVAILABLE');
        expect(res.body.dependencies).toBeUndefined();
      }
    });

    it('does not let settings.edit write around system.manage', async () => {
      const res = await request(app).put('/api/admin/settings/general').set('Authorization', `Bearer ${token}`)
        .send({ degradation_enforcement: 'observe', degradation_forced_off: ['uploads.new'], degradation_cpu_thresholds: { throttlePercent: 5 } });
      expect(res.status).toBeLessThan(500);
      const value = async (key) => decodeSettingValue(db, (await db('app_settings').where({ setting_key: key }).first())?.setting_value);
      expect(await value('degradation_enforcement')).toBe('enforce');
      expect(await value('degradation_forced_off')).toEqual([]);
      expect(await db('app_settings').where({ setting_key: 'degradation_cpu_thresholds' }).first()).toBeUndefined();
    });

    it('gives no way to force a paused capability on', async () => {
      await health.updateSettings({ forcedOff: [] });
      expect(capability('uploads.new').available).toBe(false);
      const res = await request(app).put('/api/admin/system-health/status/settings')
        .set('Authorization', `Bearer ${token}`).send({ forcedOff: ['auth.login'] });
      expect(res.status).toBe(400);
    });
  });
});
