/**
 * The restore test routes: backend flag gate, backup.view to read,
 * backup.restore to run, and the validated settings keys on PUT /config.
 * Auth is stubbed; the permission stub reads the caller's permissions from a
 * header so each route's required permission is observable.
 */

const express = require('express');
const request = require('supertest');
const { bootCrmDb } = require('./helpers/crmDb');

jest.mock('../../src/middleware/auth', () => ({
  adminAuth: (req, _res, next) => { req.admin = { id: 1 }; next(); },
  customerAuth: (_req, _res, next) => next(),
  galleryAuth: (_req, _res, next) => next(),
}));

jest.mock('../../src/middleware/permissions', () => {
  const allowed = (req, permission) => String(req.headers['x-perms'] || '').split(',').includes(permission);
  return {
    requirePermission: (permission) => (req, res, next) => (allowed(req, permission) ? next() : res.status(403).json({ error: 'forbidden' })),
    requireSuperAdmin: () => (_req, res) => res.status(403).json({ error: 'forbidden' }),
    isSuperAdminUser: async () => true,
  };
});

jest.setTimeout(120000);

describe('backup restore test routes', () => {
  let db;
  let cleanup;
  let app;
  let flags;
  let verification;

  async function setFlag(on) {
    await db('feature_flags').where({ key: 'backupRestoreTest' }).update({ value: on });
    flags.invalidateFeatureFlagCache();
  }

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    flags = require('../../src/middleware/requireFeatureFlag');
    verification = require('../../src/services/backupVerificationService');
    app = express();
    app.use(express.json());
    app.use('/api/admin/backup', require('../../src/routes/adminBackup'));
  });

  afterAll(async () => { if (cleanup) await cleanup(); });

  beforeEach(async () => {
    jest.restoreAllMocks();
    await setFlag(true);
  });

  it('refuses both routes with the flag off, whatever the permissions', async () => {
    await setFlag(false);
    const perms = 'backup.view,backup.restore';
    const list = await request(app).get('/api/admin/backup/verifications').set('x-perms', perms);
    expect(list.status).toBe(403);
    expect(list.body.code).toBe('BACKUP_RESTORE_TEST_DISABLED');
    const run = await request(app).post('/api/admin/backup/verifications').set('x-perms', perms).send({});
    expect(run.status).toBe(403);
  });

  it('lists with backup.view', async () => {
    expect((await request(app).get('/api/admin/backup/verifications').set('x-perms', 'backup.create')).status).toBe(403);
    const res = await request(app).get('/api/admin/backup/verifications').set('x-perms', 'backup.view');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ items: [], health: 'none', staleDays: 14, settings: { enabled: true, cron: '0 4 * * 0', samplePercent: 5 } });
  });

  it('runs only with backup.restore', async () => {
    const start = jest.spyOn(verification, 'startNow');
    expect((await request(app).post('/api/admin/backup/verifications').set('x-perms', 'backup.view,backup.create').send({})).status).toBe(403);
    expect(start).not.toHaveBeenCalled();
    const res = await request(app).post('/api/admin/backup/verifications').set('x-perms', 'backup.restore').send({});
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NO_BACKUP');
  });

  it('validates the run body and maps a busy install to 409', async () => {
    const perms = 'backup.restore';
    expect((await request(app).post('/api/admin/backup/verifications').set('x-perms', perms).send({ backupRunId: 'x' })).status).toBe(400);
    expect((await request(app).post('/api/admin/backup/verifications').set('x-perms', perms).send({ full: 'yes' })).status).toBe(400);
    expect((await request(app).post('/api/admin/backup/verifications').set('x-perms', perms)
      .send({ backupRunId: 1, databaseBackupRunId: 1 })).status).toBe(400);
    jest.spyOn(verification, 'startNow').mockRejectedValue(Object.assign(new Error('busy'), { code: 'VERIFICATION_BUSY' }));
    const res = await request(app).post('/api/admin/backup/verifications').set('x-perms', perms).send({});
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('VERIFICATION_BUSY');
  });

  it('validates the restore test settings on PUT /config', async () => {
    const put = (body) => request(app).put('/api/admin/backup/config').set('x-perms', 'backup.create').send(body);
    expect((await put({ backup_verify_cron: 'every sunday' })).status).toBe(400);
    expect((await put({ backup_verify_sample_percent: 101 })).status).toBe(400);
    expect((await put({ backup_verify_enabled: 'true' })).status).toBe(400);
  });
});
