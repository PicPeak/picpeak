/**
 * The two history cleanups (DELETE /cleanup → cleanupOldBackupRuns, and
 * DELETE /s3/cleanup) must not undo backup retention: restore points that
 * retention keeps, the monthly ones included, survive both. Review round 1
 * of PR 2461, concern 6.
 */

const fs = require('fs').promises;
const path = require('path');
const express = require('express');
const request = require('supertest');
const { bootCrmDb } = require('./helpers/crmDb');

const mockObjects = new Map();
jest.mock('../../src/services/storage/s3Storage', () => jest.fn().mockImplementation(() => ({
  testConnection: jest.fn().mockResolvedValue(true),
  upload: jest.fn(async (file, key) => { mockObjects.set(key, { body: await require('fs').promises.readFile(file), at: new Date() }); }),
  uploadStream: jest.fn(),
  getMetadata: jest.fn(async (key) => ({ ContentLength: mockObjects.get(key)?.body.length })),
  downloadStream: jest.fn(async (key) => require('stream').Readable.from([mockObjects.get(key).body])),
  list: jest.fn(async (prefix) => ({
    Contents: [...mockObjects.entries()].filter(([key]) => key.startsWith(prefix))
      .map(([Key, value]) => ({ Key, LastModified: value.at, Size: value.body.length })),
    IsTruncated: false,
  })),
  deleteMany: jest.fn(async (keys) => {
    keys.forEach((key) => mockObjects.delete(key));
    return { Deleted: keys.map((Key) => ({ Key })), Errors: [] };
  }),
})));

jest.mock('../../src/middleware/auth', () => ({
  adminAuth: (req, _res, next) => { req.admin = { id: 1 }; next(); },
  customerAuth: (_req, _res, next) => next(),
  galleryAuth: (_req, _res, next) => next(),
}));
jest.mock('../../src/middleware/permissions', () => ({
  requirePermission: () => (_req, _res, next) => next(),
  requireSuperAdmin: () => (_req, _res, next) => next(),
  isSuperAdminUser: async () => true,
}));

jest.setTimeout(240000);

describe('history cleanups keep the restore points retention keeps', () => {
  let db;
  let cleanup;
  let fixtureRoot;
  let backupService;
  let databaseBackupService;
  let app;

  async function setting(key, value) {
    await db('app_settings').insert({ setting_key: key, setting_value: JSON.stringify(value), setting_type: 'backup' })
      .onConflict('setting_key').merge();
  }
  const monthsAgo = (n, day) => {
    const d = new Date();
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - n, day, 10, 0, 0));
  };
  async function backupAt(when) {
    await databaseBackupService.backup({ destinationPath: path.join(fixtureRoot, 'dumps'), inline: true });
    await backupService.runBackup(true);
    const run = await db('backup_runs').orderBy('id', 'desc').first();
    expect(run.status).toBe('completed');
    if (when) {
      await db('backup_runs').where({ id: run.id }).update({ completed_at: when.toISOString(), started_at: when.toISOString() });
      // The S3 objects of that run are as old as the run.
      for (const value of mockObjects.values()) if (!value.dated) Object.assign(value, { at: when, dated: true });
    } else {
      for (const value of mockObjects.values()) value.dated = true;
    }
    return db('backup_runs').where({ id: run.id }).first();
  }
  const remaining = async () => (await db('backup_runs').orderBy('id').select('id')).map((r) => r.id);
  // A cleanup run with retention set to keep everything that is a backup
  // run is too permissive to show anything; keep = 1 + monthly = 3, and a
  // "first of month" run two months back that must survive.
  async function scenario() {
    await setting('backup_retention_count', 0); // build history without pruning
    const tooOld = await backupAt(monthsAgo(4, 2));
    const monthly = await backupAt(monthsAgo(2, 2));
    const notFirst = await backupAt(monthsAgo(2, 20));
    const current = await backupAt(null);
    await setting('backup_retention_count', 1);
    await setting('backup_retention_monthly_count', 3);
    return { tooOld, monthly, notFirst, current };
  }

  beforeAll(async () => {
    ({ db, cleanup, tmpDir: fixtureRoot } = await bootCrmDb());
    backupService = require('../../src/services/backupService');
    ({ databaseBackupService } = require('../../src/services/databaseBackup'));
    await fs.mkdir(path.join(process.env.STORAGE_PATH, 'business-docs'), { recursive: true });
    await fs.writeFile(path.join(process.env.STORAGE_PATH, 'business-docs', 'a.pdf'), 'doc');
    app = express();
    app.use(express.json());
    app.use('/api/admin/backup', require('../../src/routes/adminBackup'));
  });
  afterAll(async () => { if (cleanup) await cleanup(); });

  beforeEach(async () => {
    mockObjects.clear();
    await db('backup_runs').del();
    for (const [key, value] of Object.entries({
      backup_enabled: false, backup_destination_path: path.join(fixtureRoot, 'local-backups'),
      backup_include_database: true, backup_database_inline_dump: false,
      backup_email_on_success: false, backup_email_on_failure: false,
      backup_retention_monthly_count: 0,
      backup_s3_bucket: 'fixture', backup_s3_access_key: 'k', backup_s3_secret_key: 's', backup_s3_prefix: 'restore-points',
    })) await setting(key, value);
  });

  it('DELETE /cleanup (cleanupOldBackupRuns) keeps the newest and the monthly restore points', async () => {
    await setting('backup_destination_type', 'local');
    const { tooOld, monthly, notFirst, current } = await scenario();

    const res = await request(app).delete('/api/admin/backup/cleanup').send({ days: 1 });

    expect(res.status).toBe(200);
    expect(await remaining()).toEqual([monthly.id, current.id]);
    expect([tooOld.id, notFirst.id].some((id) => [monthly.id, current.id].includes(id))).toBe(false);
  });

  it('DELETE /s3/cleanup keeps the objects and rows of the restore points retention keeps', async () => {
    await setting('backup_destination_type', 's3');
    const { tooOld, monthly, notFirst, current } = await scenario();
    const prefixOf = (run) => String(run.manifest_path).replace(/^s3:\/\/[^/]+\//, '').replace(/\/manifests\/[^/]+$/, '');
    const has = (run) => [...mockObjects.keys()].some((key) => key.startsWith(`${prefixOf(run)}/`));

    const res = await request(app).delete('/api/admin/backup/s3/cleanup').send({ retentionDays: 1 });

    expect(res.status).toBe(200);
    expect(res.body.keptByRetention).toBe(1);
    expect(has(monthly)).toBe(true);
    expect(has(current)).toBe(true);
    expect(has(tooOld)).toBe(false);
    expect(has(notFirst)).toBe(false);
    expect(await remaining()).toEqual([monthly.id, current.id]);
  });

  it('with retention keeping everything (count 0), DELETE /cleanup still removes old rows as before', async () => {
    await setting('backup_destination_type', 'local');
    const { current } = await scenario();
    await setting('backup_retention_count', 0);

    const res = await request(app).delete('/api/admin/backup/cleanup').send({ days: 1 });

    expect(res.status).toBe(200);
    expect(res.body.keptByRetention).toBe(0);
    expect(await remaining()).toEqual([current.id]);
  });
});
