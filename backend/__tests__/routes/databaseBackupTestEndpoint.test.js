/**
 * POST /api/admin/database-backup/test checks whether the backup destination
 * is writable. It read an unprefixed `destinationPath` that getBackupConfig()
 * never returns (the settings are database_backup_*), so the check was
 * skipped and the destination always came back unwritable. It now tests the
 * directory a real backup writes to, resolved the same way backup() does.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-dbbackup-test-'));
process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(tmpRoot, 'db.sqlite');
process.env.STORAGE_PATH = path.join(tmpRoot, 'storage');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'dbbackup-test-endpoint-secret';

const request = require('supertest');
const express = require('express');
const jwt = require('jsonwebtoken');

const { bootCrmDb, seedMinimal, assignAdminRole } = require('../integration/helpers/crmDb');

describe('database backup test endpoint', () => {
  let db; let cleanup; let app; let token;

  const setSetting = async (key, value, type) => {
    const row = { setting_key: key, setting_value: JSON.stringify(value), setting_type: type };
    const existing = await db('app_settings').where({ setting_key: key }).first();
    if (existing) await db('app_settings').where({ setting_key: key }).update(row);
    else await db('app_settings').insert(row);
  };
  const runTest = () => request(app)
    .post('/api/admin/database-backup/test')
    .set('Authorization', `Bearer ${token}`);

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    // bootCrmDb points storage at its own temp dir; keep ours for the derived path.
    process.env.STORAGE_PATH = path.join(tmpRoot, 'storage');
    const { adminId } = await seedMinimal(db);
    await assignAdminRole(db, adminId, 'super_admin');
    token = jwt.sign(
      { id: adminId, username: 'admin', type: 'admin', loginTime: Date.now() },
      process.env.JWT_SECRET,
      { expiresIn: '1h', issuer: 'picpeak-auth' },
    );
    app = express();
    app.use(express.json());
    app.use('/api/admin/database-backup', require('../../src/routes/adminDatabaseBackup'));
  }, 120000);

  afterAll(async () => {
    if (cleanup) await cleanup();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('tests a customised database backup directory', async () => {
    const custom = path.join(tmpRoot, 'custom-db-dumps');
    await setSetting('database_backup_destination_path', custom, 'database_backup');

    const res = await runTest();

    expect(res.status).toBe(200);
    expect(res.body.results.destinationPath).toBe(custom);
    expect(res.body.results.destinationWritable).toBe(true);
    expect(fs.existsSync(custom)).toBe(true);
  });

  it('tests the derived directory under the backup destination when the seeded default is not usable', async () => {
    // Skip where /backup happens to be writable (then the legacy path is kept).
    let legacyWritable = false;
    try { fs.accessSync('/backup', fs.constants.W_OK); legacyWritable = true; } catch (_) { /* expected */ }
    if (legacyWritable) return;

    const fileBackups = path.join(tmpRoot, 'file-backups');
    await setSetting('database_backup_destination_path', '/backup/database', 'database_backup');
    await setSetting('backup_destination_path', fileBackups, 'backup');

    const res = await runTest();

    expect(res.status).toBe(200);
    expect(res.body.results.destinationPath).toBe(path.join(fileBackups, 'database'));
    expect(res.body.results.destinationWritable).toBe(true);
  });

  it('reports an unwritable directory with its path and the setting to change', async () => {
    const locked = path.join(tmpRoot, 'locked');
    fs.mkdirSync(locked, { recursive: true });
    fs.chmodSync(locked, 0o500);
    const target = path.join(locked, 'db');
    await setSetting('database_backup_destination_path', target, 'database_backup');

    try {
      const res = await runTest();

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(false);
      expect(res.body.results.destinationWritable).toBe(false);
      expect(res.body.results.destinationError).toContain(target);
      expect(res.body.results.destinationError).toContain('database_backup_destination_path');
    } finally {
      fs.chmodSync(locked, 0o700);
    }
  });

  it('refuses a publicly served directory without writing to it', async () => {
    const publicDir = path.join(process.env.STORAGE_PATH, 'uploads', 'logos', 'db');
    await setSetting('database_backup_destination_path', publicDir, 'database_backup');

    const res = await runTest();

    expect(res.body.results.destinationWritable).toBe(false);
    expect(res.body.results.destinationError).toMatch(/publicly served/);
    expect(fs.existsSync(publicDir)).toBe(false);
  });
});
