/**
 * Backup credential exposure regression tests.
 *
 * The generic settings reads (GET /admin/settings, GET /admin/settings/:type)
 * masked the recaptcha/umami/rybbit keys but returned backup_s3_secret_key
 * and backup_rsync_ssh_key (an SSH PRIVATE KEY) in plaintext to any
 * settings.view holder; GET /admin/backup/config returned them too. Both now
 * mask, and PUT /admin/backup/config skips the mask sentinel so the edit
 * form round-trips without clobbering stored credentials.
 */

const request = require('supertest');
const express = require('express');

const { bootCrmDb } = require('./helpers/crmDb');

jest.mock('../../src/middleware/auth', () => ({
  adminAuth: (req, _res, next) => {
    req.admin = { id: 1, username: 'test-admin' };
    next();
  },
}));
jest.mock('../../src/middleware/permissions', () => ({
  requirePermission: () => (_req, _res, next) => next(),
  requireSuperAdmin: () => (_req, _res, next) => next(),
}));

describe('backup credential masking', () => {
  let db;
  let cleanup;
  let app;

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());

    // Upsert: several backup_* keys are pre-seeded by the backup migrations.
    const seed = [
      { setting_key: 'backup_destination_type', setting_value: JSON.stringify('s3'), setting_type: 'backup' },
      { setting_key: 'backup_s3_endpoint', setting_value: JSON.stringify('https://s3.example.com'), setting_type: 'backup' },
      { setting_key: 'backup_s3_bucket', setting_value: JSON.stringify('backups'), setting_type: 'backup' },
      { setting_key: 'backup_s3_access_key', setting_value: JSON.stringify('AKIAEXAMPLE'), setting_type: 'backup' },
      { setting_key: 'backup_s3_secret_key', setting_value: JSON.stringify('super-secret-s3-key'), setting_type: 'backup' },
      { setting_key: 'backup_rsync_ssh_key', setting_value: JSON.stringify('-----BEGIN OPENSSH PRIVATE KEY-----abc'), setting_type: 'backup' },
    ];
    for (const row of seed) {
      await db('app_settings').insert(row).onConflict('setting_key').merge();
    }

    app = express();
    app.use(express.json());
    app.use('/api/admin/backup', require('../../src/routes/adminBackup'));
    app.use('/api/admin/settings', require('../../src/routes/adminSettings'));
  }, 120000);

  afterAll(async () => {
    if (cleanup) await cleanup();
  });

  it('masks the credentials in GET /admin/backup/config', async () => {
    const res = await request(app).get('/api/admin/backup/config').expect(200);
    expect(res.body.backup_s3_secret_key).toBe('••••••••');
    expect(res.body.backup_rsync_ssh_key).toBe('••••••••');
    // Non-secret fields stay readable for the form.
    expect(res.body.backup_s3_bucket).toBe('backups');
  });

  it('masks the credentials in the generic GET /admin/settings/:type read', async () => {
    const res = await request(app).get('/api/admin/settings/backup').expect(200);
    expect(res.body.backup_s3_secret_key).toBe('••••••••');
    expect(res.body.backup_rsync_ssh_key).toBe('••••••••');
  });

  it('masks the credentials in the generic GET /admin/settings read', async () => {
    const res = await request(app).get('/api/admin/settings').expect(200);
    expect(res.body.backup_s3_secret_key).toBe('••••••••');
    expect(res.body.backup_rsync_ssh_key).toBe('••••••••');
  });

  it('PUT /admin/backup/config keeps the stored secret when the sentinel round-trips', async () => {
    await request(app)
      .put('/api/admin/backup/config')
      .send({
        backup_destination_type: 's3',
        backup_s3_endpoint: 'https://s3.example.com',
        backup_s3_bucket: 'renamed-bucket',
        backup_s3_access_key: 'AKIAEXAMPLE',
        backup_s3_secret_key: '••••••••',
        backup_rsync_ssh_key: '••••••••',
      })
      .expect(200);

    const secret = await db('app_settings').where({ setting_key: 'backup_s3_secret_key' }).first();
    expect(JSON.parse(secret.setting_value)).toBe('super-secret-s3-key');
    const sshKey = await db('app_settings').where({ setting_key: 'backup_rsync_ssh_key' }).first();
    expect(JSON.parse(sshKey.setting_value)).toBe('-----BEGIN OPENSSH PRIVATE KEY-----abc');
    const bucket = await db('app_settings').where({ setting_key: 'backup_s3_bucket' }).first();
    expect(JSON.parse(bucket.setting_value)).toBe('renamed-bucket');
  });

  it('PUT /admin/backup/config stores a genuinely new secret', async () => {
    await request(app)
      .put('/api/admin/backup/config')
      .send({ backup_s3_secret_key: 'rotated-s3-key' })
      .expect(200);

    const secret = await db('app_settings').where({ setting_key: 'backup_s3_secret_key' }).first();
    expect(JSON.parse(secret.setting_value)).toBe('rotated-s3-key');
  });
});
