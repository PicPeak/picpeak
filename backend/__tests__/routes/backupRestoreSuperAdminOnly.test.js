/**
 * Backups decide who holds a full copy of the instance, restores who can
 * replace it.
 *
 * backup.create, held by the built-in admin role, still runs backups and sets
 * the schedule. Changing where backups go, or whether they carry the
 * database, is Super Admin only. So are restores and the portable import:
 * both replace admin accounts and roles, so a lesser role running one could
 * bring in a Super Admin account of its own.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-backup-super-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'backup-super-test-secret';

const request = require('supertest');
const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const { bootCrmDb } = require('../integration/helpers/crmDb');

describe('backup destinations, restores and portable import are Super Admin only', () => {
  let db;
  let cleanup;
  let app;
  let superToken;
  let adminToken;
  let operatorToken;

  const insertId = async (table, row) => {
    const inserted = await db(table).insert(row).returning('id');
    return inserted[0]?.id ?? inserted[0];
  };

  const tokenFor = async (username, roleName) => {
    const role = await db('roles').where({ name: roleName }).first();
    const id = await insertId('admin_users', {
      username,
      email: `${username}@example.com`,
      password_hash: await bcrypt.hash('Passw0rd!', 4),
      role_id: role.id,
      is_active: 1,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    return jwt.sign(
      { id, username, type: 'admin', role: roleName, loginTime: Date.now() },
      process.env.JWT_SECRET,
      { expiresIn: '1h', issuer: 'picpeak-auth' },
    );
  };

  const storedSetting = async (key) => {
    const row = await db('app_settings').where({ setting_key: key }).first();
    return row ? JSON.parse(row.setting_value) : undefined;
  };

  const setBackupSettings = async (settings) => {
    await db('app_settings').where({ setting_type: 'backup' }).del();
    for (const [key, value] of Object.entries(settings)) {
      await db('app_settings').insert({
        setting_key: key, setting_value: JSON.stringify(value), setting_type: 'backup',
        updated_at: new Date().toISOString(),
      });
    }
  };

  const putConfig = (token, body) => request(app)
    .put('/api/admin/backup/config')
    .set('Authorization', `Bearer ${token}`)
    .send(body);

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    const operatorRoleId = await insertId('roles', {
      name: 'restore-operator', display_name: 'Restore operator', description: 'test role', is_system: false, priority: 10,
    });
    const permissions = await db('permissions').whereIn('name', ['backup.view', 'backup.create', 'backup.restore']).select('id');
    for (const permission of permissions) {
      await db('role_permissions').insert({ role_id: operatorRoleId, permission_id: permission.id });
    }
    superToken = await tokenFor('root-admin', 'super_admin');
    adminToken = await tokenFor('limited-admin', 'admin');
    operatorToken = await tokenFor('restore-operator', 'restore-operator');

    app = express();
    app.use(express.json());
    app.use('/api/admin/backup', require('../../src/routes/adminBackup'));
    app.use('/api/admin/restore', require('../../src/routes/adminRestore'));
  }, 120000);

  beforeEach(async () => {
    await setBackupSettings({
      backup_destination_type: 'local',
      backup_destination_path: '/srv/backups',
      backup_retention_days: 30,
    });
  });

  afterAll(async () => { if (cleanup) await cleanup(); });

  it('refuses the admin role pointing backups at a new S3 destination', async () => {
    const res = await putConfig(adminToken, {
      backup_destination_type: 's3',
      backup_s3_endpoint: 'https://s3.elsewhere.example',
      backup_s3_bucket: 'copy',
      backup_s3_access_key: 'key',
      backup_s3_secret_key: 'secret',
    });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SUPER_ADMIN_REQUIRED');
    expect(await storedSetting('backup_destination_type')).toBe('local');
    expect(await storedSetting('backup_s3_endpoint')).toBeUndefined();
  });

  it('refuses the admin role changing whether backups include the database', async () => {
    await setBackupSettings({ backup_destination_type: 'local', backup_destination_path: '/srv/backups', backup_include_database: false });

    const res = await putConfig(adminToken, { backup_include_database: true });

    expect(res.status).toBe(403);
    expect(await storedSetting('backup_include_database')).toBe(false);
  });

  it('lets the admin role change the schedule and retention', async () => {
    const res = await putConfig(adminToken, { backup_schedule: 'weekly', backup_retention_days: 14 });

    expect(res.status).toBe(200);
    expect(await storedSetting('backup_schedule')).toBe('weekly');
    expect(await storedSetting('backup_retention_days')).toBe(14);
  });

  it('lets the admin role save the whole form while the destination stays the same', async () => {
    const res = await putConfig(adminToken, {
      backup_destination_type: 'local',
      backup_destination_path: '/srv/backups',
      backup_rsync_host: '',
      backup_s3_secret_key: '••••••••',
      backup_include_database: true,
      backup_retention_days: 7,
    });

    expect(res.status).toBe(200);
    expect(await storedSetting('backup_retention_days')).toBe(7);
  });

  it('lets a Super Admin change the destination', async () => {
    const res = await putConfig(superToken, { backup_destination_type: 'local', backup_destination_path: '/srv/other' });

    expect(res.status).toBe(200);
    expect(await storedSetting('backup_destination_path')).toBe('/srv/other');
  });

  it('refuses the admin role testing a destination connection', async () => {
    const res = await request(app)
      .post('/api/admin/backup/test-connection')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ destination_type: 'local', path: os.tmpdir() });

    expect(res.status).toBe(403);
  });

  it('keeps the portable import for Super Admins', async () => {
    const operator = await request(app)
      .post('/api/admin/backup/picpeak/import')
      .set('Authorization', `Bearer ${operatorToken}`);
    const superAdmin = await request(app)
      .post('/api/admin/backup/picpeak/import')
      .set('Authorization', `Bearer ${superToken}`);

    expect(operator.status).toBe(403);
    // Past the gate: refused only for the missing file.
    expect(superAdmin.status).toBe(400);
  });

  it('keeps restore validation and start for Super Admins', async () => {
    const validate = await request(app).post('/api/admin/restore/validate').set('Authorization', `Bearer ${operatorToken}`).send({});
    const start = await request(app).post('/api/admin/restore/start').set('Authorization', `Bearer ${operatorToken}`).send({});
    const superValidate = await request(app).post('/api/admin/restore/validate').set('Authorization', `Bearer ${superToken}`).send({});

    expect(validate.status).toBe(403);
    expect(start.status).toBe(403);
    // Past the gate: refused only for the missing fields.
    expect(superValidate.status).toBe(400);
  });
});
