/**
 * PUT /api/admin/database-backup/config must reject a
 * database_backup_destination_path that resolves inside a publicly served
 * directory (GHSA-jw8m-43r2-jqrm class, #1365).
 *
 * Before #1365, database_backup_destination_path was silently ignored by
 * databaseBackupService.backup() (a destructuring bug always fell back to
 * the hardcoded /backup/database), so this setting being freely writable by
 * any backup.create holder — the built-in `admin` role has it without
 * settings.edit or backup.restore — was harmless. Making the setting
 * actually take effect reopens the exact exfiltration path GHSA-jw8m fixed
 * for the per-request override, through the persisted setting instead.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-dbbackup-config-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'dbbackup-config-test-secret';
process.env.STORAGE_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-dbbackup-storage-'));

const request = require('supertest');
const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const { bootCrmDb, seedMinimal } = require('../integration/helpers/crmDb');
const { decodeSettingValue } = require('../helpers/settingValue');

describe('database backup destination-path config guard (GHSA-jw8m class, #1365)', () => {
  let db; let cleanup; let app; let adminToken; let superToken;

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    await seedMinimal(db);

    const role = await db('roles').where({ name: 'admin' }).first();
    const r = await db('admin_users').insert({
      username: 'limited-admin',
      email: 'limited-admin-config@example.com',
      password_hash: await bcrypt.hash('Passw0rd!', 4),
      role_id: role.id,
      is_active: 1,
      created_at: new Date(),
      updated_at: new Date(),
    }).returning('id');
    const id = r[0]?.id ?? r[0];
    adminToken = jwt.sign(
      { id, username: 'limited-admin', type: 'admin', role: 'admin', loginTime: Date.now() },
      process.env.JWT_SECRET,
      { expiresIn: '1h', issuer: 'picpeak-auth' },
    );
    // Changing the destination became a super-admin action (security audit
    // 2026-09-30: a backup.create holder could otherwise aim the dump into the
    // file-backup tree any backup.view holder downloads). The public-mount
    // rejections above still answer 400 for the limited admin, since that
    // check runs first; the accepting case needs a super admin.
    const superRole = await db('roles').where({ name: 'super_admin' }).first();
    const s = await db('admin_users').insert({
      username: 'root-admin-config',
      email: 'root-admin-config@example.com',
      password_hash: await bcrypt.hash('Passw0rd!', 4),
      role_id: superRole.id,
      is_active: 1,
      created_at: new Date(),
      updated_at: new Date(),
    }).returning('id');
    const superId = s[0]?.id ?? s[0];
    superToken = jwt.sign(
      { id: superId, username: 'root-admin-config', type: 'admin', role: 'super_admin', loginTime: Date.now() },
      process.env.JWT_SECRET,
      { expiresIn: '1h', issuer: 'picpeak-auth' },
    );

    app = express();
    app.use(express.json());
    app.use('/api/admin/database-backup', require('../../src/routes/adminDatabaseBackup'));
  }, 120000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  it('rejects a destination inside the public uploads/logos mount', async () => {
    const res = await request(app)
      .put('/api/admin/database-backup/config')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ database_backup_destination_path: path.join(process.env.STORAGE_PATH, 'uploads', 'logos') });

    expect(res.status).toBe(400);

    // The seeded default must survive untouched — the rejected value never lands.
    const row = await db('app_settings').where({ setting_key: 'database_backup_destination_path' }).first();
    expect(decodeSettingValue(db, row.setting_value)).toBe('/backup/database');
  });

  it('rejects a destination inside the public fonts mount', async () => {
    const res = await request(app)
      .put('/api/admin/database-backup/config')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ database_backup_destination_path: path.join(process.env.STORAGE_PATH, 'fonts') });

    expect(res.status).toBe(400);
  });

  it('accepts a destination outside any public mount (from a super admin)', async () => {
    const safePath = path.join(process.env.STORAGE_PATH, 'db-backups');
    const limited = await request(app)
      .put('/api/admin/database-backup/config')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ database_backup_destination_path: safePath });
    expect(limited.status).toBe(403);
    expect(limited.body.code).toBe('SUPER_ADMIN_REQUIRED');

    const res = await request(app)
      .put('/api/admin/database-backup/config')
      .set('Authorization', `Bearer ${superToken}`)
      .send({ database_backup_destination_path: safePath });

    expect(res.status).toBe(200);

    const row = await db('app_settings').where({ setting_key: 'database_backup_destination_path' }).first();
    expect(decodeSettingValue(db, row.setting_value)).toBe(safePath);
  });

  // A retention of 0 or less pushes cleanupOldBackups' cutoff to today or
  // the future, deleting every completed backup on the next scheduled run
  // — a backup.create holder achieving what backup.delete gates on /cleanup.
  it.each([-1, 0])('rejects database_backup_retention_days=%s', async (bad) => {
    const res = await request(app)
      .put('/api/admin/database-backup/config')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ database_backup_retention_days: bad });

    expect(res.status).toBe(400);
  });

  it('accepts a positive database_backup_retention_days', async () => {
    const res = await request(app)
      .put('/api/admin/database-backup/config')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ database_backup_retention_days: 90 });

    expect(res.status).toBe(200);

    const row = await db('app_settings').where({ setting_key: 'database_backup_retention_days' }).first();
    expect(decodeSettingValue(db, row.setting_value)).toBe(90);
  });
});
