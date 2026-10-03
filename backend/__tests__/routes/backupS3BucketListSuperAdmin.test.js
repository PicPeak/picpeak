/**
 * GET /api/admin/backup/s3/buckets runs an account-wide ListBuckets with the
 * stored backup credential — provider inventory beyond PicPeak's configured
 * bucket. backup.view ("view backup status and history") does not cover
 * that; the route is Super Admin only, like /test-connection, and the
 * account Owner object stays out of the response.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-backup-buckets-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'backup-buckets-test-secret';

const request = require('supertest');
const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { S3Client } = require('@aws-sdk/client-s3');

const { bootCrmDb } = require('../integration/helpers/crmDb');

describe('GET /api/admin/backup/s3/buckets', () => {
  let db; let cleanup; let app; let superToken; let adminToken; let viewerToken;

  const insertId = async (table, row) => {
    const inserted = await db(table).insert(row).returning('id');
    return inserted[0]?.id ?? inserted[0];
  };

  const tokenFor = async (username, roleName) => {
    const role = await db('roles').where({ name: roleName }).first();
    const id = await insertId('admin_users', {
      username, email: `${username}@example.com`,
      password_hash: await bcrypt.hash('Passw0rd!', 4), role_id: role.id, is_active: 1,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    });
    return jwt.sign(
      { id, username, type: 'admin', role: roleName, loginTime: Date.now() },
      process.env.JWT_SECRET, { expiresIn: '1h', issuer: 'picpeak-auth' },
    );
  };

  const get = (token) => request(app).get('/api/admin/backup/s3/buckets').set('Authorization', `Bearer ${token}`);

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());

    const viewerRoleId = await insertId('roles', {
      name: 'backup-viewer', display_name: 'Backup viewer', description: 'test role', is_system: false, priority: 10,
    });
    const perm = await db('permissions').where({ name: 'backup.view' }).first();
    await db('role_permissions').insert({ role_id: viewerRoleId, permission_id: perm.id });

    superToken = await tokenFor('root-admin', 'super_admin');
    adminToken = await tokenFor('limited-admin', 'admin');
    viewerToken = await tokenFor('backup-viewer', 'backup-viewer');

    await db('app_settings').where({ setting_type: 'backup' }).del();
    for (const [key, value] of Object.entries({
      backup_enabled: true,
      backup_schedule: '0 2 * * *',
      backup_destination_type: 's3',
      backup_s3_endpoint: 'https://s3.example.com',
      backup_s3_bucket: 'picpeak-backups',
      backup_s3_access_key: 'AKIA-TEST',
      backup_s3_secret_key: 'secret',
      backup_s3_region: 'us-east-1',
    })) {
      await db('app_settings').insert({
        setting_key: key, setting_value: JSON.stringify(value), setting_type: 'backup',
        updated_at: new Date().toISOString(),
      });
    }

    jest.spyOn(S3Client.prototype, 'send').mockResolvedValue({
      Buckets: [{ Name: 'picpeak-backups' }, { Name: 'company-finance' }],
      Owner: { ID: 'account-owner-id', DisplayName: 'company-root' },
    });

    app = express();
    app.use(express.json());
    app.use('/api/admin/backup', require('../../src/routes/adminBackup'));
  }, 120000);

  afterAll(async () => {
    jest.restoreAllMocks();
    if (cleanup) await cleanup();
  });

  it('refuses a backup.view role', async () => {
    const res = await get(viewerToken);
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/super admin/i);
  });

  it('refuses the built-in admin role', async () => {
    const res = await get(adminToken);
    expect(res.status).toBe(403);
  });

  it('lists buckets for a super_admin without the account Owner', async () => {
    const res = await get(superToken);
    expect(res.status).toBe(200);
    expect(res.body.buckets.map((b) => b.Name)).toEqual(['picpeak-backups', 'company-finance']);
    expect(res.body).not.toHaveProperty('owner');
    expect(JSON.stringify(res.body)).not.toContain('account-owner-id');
  });
});
