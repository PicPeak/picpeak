/**
 * The database dump's destination decides who can read it: the file-backup
 * download route zips `<backup_destination_path>/backup-<run>` for any
 * backup.view holder. A backup.create holder who could point the dump at one
 * of those directories could pull the whole database past the
 * super-admin-only export (Codex security audit 2026-09-30). Changing the
 * destination is a super-admin decision; every other setting stays with
 * backup.create.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-dbdest-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'dbdest-test-secret';
process.env.STORAGE_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-dbdest-storage-'));

const request = require('supertest');
const { bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken, buildRouteApp } = require('../integration/helpers/crmDb');
const { clearPermissionCache } = require('../../src/middleware/permissions');

const KEY = 'database_backup_destination_path';

describe('PUT /api/admin/database-backup/config — destination is super-admin only', () => {
  let db; let cleanup; let app;
  const tok = {};
  const as = (who) => request(app).put('/api/admin/database-backup/config').set('Authorization', `Bearer ${tok[who]}`);
  const stored = async () => {
    const row = await db('app_settings').where({ setting_key: KEY }).first();
    return row ? JSON.parse(row.setting_value) : undefined;
  };

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    const { adminId } = await seedMinimal(db);
    await assignAdminRole(db, adminId, 'super_admin');
    tok.super = mintAdminToken(adminId);
    const rows = await db('admin_users').insert({
      username: 'dbdest-admin', email: 'dbdest-admin@example.com', password_hash: 'x',
      must_change_password: false, created_at: new Date().toISOString(),
    }).returning('id');
    const plainId = rows[0]?.id ?? rows[0];
    await assignAdminRole(db, plainId, 'admin'); // built-in admin: backup.create + backup.view, not super admin
    tok.admin = mintAdminToken(plainId);
    clearPermissionCache();
    app = buildRouteApp('/api/admin/database-backup', require('../../src/routes/adminDatabaseBackup'));
  }, 120000);
  afterAll(async () => { if (cleanup) await cleanup(); });

  it('refuses a destination change from a backup.create holder who is not a super admin', async () => {
    const before = await stored(); // migration 030 seeds a default
    const res = await as('admin').send({ [KEY]: path.join(process.env.STORAGE_PATH, 'backups', 'backup-7') });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SUPER_ADMIN_REQUIRED');
    expect(await stored()).toBe(before);
  });

  it('lets that holder save the other settings, including an unchanged destination', async () => {
    await as('super').send({ [KEY]: '/var/backups/picpeak-db' }).expect(200);
    const res = await as('admin').send({ [KEY]: '/var/backups/picpeak-db', database_backup_compress: false });
    expect(res.status).toBe(200);
    const compress = await db('app_settings').where({ setting_key: 'database_backup_compress' }).first();
    expect(JSON.parse(compress.setting_value)).toBe(false);
    expect(await stored()).toBe('/var/backups/picpeak-db');
  });

  it('lets a super admin change it', async () => {
    const res = await as('super').send({ [KEY]: '/var/backups/picpeak-db-2' });
    expect(res.status).toBe(200);
    expect(await stored()).toBe('/var/backups/picpeak-db-2');
  });

  // The path used to be interpolated into `sqlite3 .backup '<path>'`, which
  // sqlite3 re-parses itself: a quote or a line break ends the filename and
  // the rest runs as a second dot-command (scanner finding d499ed38).
  describe('sqlite3 dot-command characters are refused at save time', () => {
    it.each([
      ['single quote', '/var/backups/x\' .shell id ; \''],
      ['double quote', '/var/backups/x" .shell id'],
      ['backtick', '/var/backups/x`id`'],
      ['backslash', '/var/backups/x\\y'],
      ['newline', '/var/backups/x\n.shell id'],
      ['carriage return', '/var/backups/x\r.shell id'],
      ['tab', '/var/backups/x\t.shell id'],
      ['NUL', '/var/backups/x\u0000.shell id'],
    ])('%s', async (_label, value) => {
      const before = await stored();
      const res = await as('super').send({ [KEY]: value });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/quotes, backslashes or control characters/);
      expect(await stored()).toBe(before);
    });

    it('still accepts an ordinary absolute path with dots, dashes and spaces', async () => {
      const res = await as('super').send({ [KEY]: '/mnt/nas share/picpeak.backups-v2' });
      expect(res.status).toBe(200);
      expect(await stored()).toBe('/mnt/nas share/picpeak.backups-v2');
    });
  });
});
