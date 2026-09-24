/**
 * A private S3 backup endpoint is denied by default and accepted only after a
 * Super Admin approves that exact origin (issue 1641). The connection test is
 * a real HeadBucket, not a stub.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const dns = require('dns');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-backup-s3-private-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'backup-s3-private-test-secret';

const request = require('supertest');
const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const { bootCrmDb } = require('../integration/helpers/crmDb');

const APPROVAL = 'backup_s3_private_endpoint_approval';

describe('private S3 backup endpoints (issue 1641)', () => {
  let db; let cleanup; let app; let superToken; let adminToken;
  let server; let port; let s3Requests;

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

  const stored = async (key) => {
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
    .put('/api/admin/backup/config').set('Authorization', `Bearer ${token}`).send(body);
  const testConnection = (body) => request(app)
    .post('/api/admin/backup/test-connection').set('Authorization', `Bearer ${superToken}`)
    .send({ destination_type: 's3', ...body });

  const s3 = (endpoint, extra = {}) => ({
    backup_destination_type: 's3',
    backup_s3_endpoint: endpoint,
    backup_s3_bucket: 'backups',
    backup_s3_access_key: 'key',
    backup_s3_secret_key: 'secret',
    ...extra,
  });

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    superToken = await tokenFor('root-admin', 'super_admin');
    adminToken = await tokenFor('limited-admin', 'admin');

    app = express();
    app.use(express.json());
    app.use('/api/admin/backup', require('../../src/routes/adminBackup'));

    server = http.createServer((req, res) => {
      s3Requests += 1;
      // HeadBucket: 200 for the right bucket, 404 otherwise.
      res.statusCode = req.url.startsWith('/backups') ? 200 : 404;
      res.end();
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    ({ port } = server.address());
  }, 120000);

  beforeEach(async () => {
    s3Requests = 0;
    process.env.NODE_ENV = 'production';
    await setBackupSettings({ backup_destination_type: 'local', backup_destination_path: '/srv/backups' });
  });

  afterEach(() => {
    process.env.NODE_ENV = 'test';
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    if (cleanup) await cleanup();
  });

  describe('PUT /config', () => {
    it('denies a private endpoint with a stable code, a warning severity and the origin to approve', async () => {
      const res = await putConfig(superToken, s3('http://10.0.0.5:9000'));

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({
        code: 'S3_PRIVATE_ENDPOINT', severity: 'warning', requiresApproval: true, origin: 'http://10.0.0.5:9000',
      });
      expect(await stored('backup_s3_endpoint')).toBeUndefined();
    });

    it('accepts it once a Super Admin approves that exact origin, and keeps accepting it', async () => {
      const first = await putConfig(superToken, s3('http://10.0.0.5:9000', { [APPROVAL]: 'http://10.0.0.5:9000' }));
      expect(first.status).toBe(200);
      expect(await stored(APPROVAL)).toBe('http://10.0.0.5:9000');

      // A later save of the same form does not have to re-send the approval.
      const again = await putConfig(superToken, s3('http://10.0.0.5:9000', { backup_retention_days: 14 }));
      expect(again.status).toBe(200);
    });

    it('does not carry an approval over to a different private endpoint', async () => {
      await putConfig(superToken, s3('http://10.0.0.5:9000', { [APPROVAL]: 'http://10.0.0.5:9000' }));
      const res = await putConfig(superToken, s3('http://10.0.0.6:9000'));
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('S3_PRIVATE_ENDPOINT');
      expect(res.body.origin).toBe('http://10.0.0.6:9000');
    });

    it('refuses an approval that names another origin', async () => {
      const res = await putConfig(superToken, s3('http://10.0.0.5:9000', { [APPROVAL]: 'http://10.0.0.5:9001' }));
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('S3_APPROVAL_MISMATCH');
    });

    it('never accepts a link-local or metadata endpoint, approved or not', async () => {
      const res = await putConfig(superToken, s3('http://169.254.169.254', { [APPROVAL]: 'http://169.254.169.254' }));
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: 'S3_ENDPOINT_FORBIDDEN', severity: 'error' });
      expect(res.body.requiresApproval).toBeUndefined();
    });

    it('re-resolves a hostname on save: a name that answers privately needs approval', async () => {
      jest.spyOn(dns.promises, 'lookup').mockResolvedValue([{ address: '192.168.10.20', family: 4 }]);
      const res = await putConfig(superToken, s3('http://rustfs.lan:9000'));
      expect(res.status).toBe(400);
      expect(res.body.origin).toBe('http://rustfs.lan:9000');
    });

    it('clears a stored approval when the endpoint moves to a public one', async () => {
      await putConfig(superToken, s3('http://10.0.0.5:9000', { [APPROVAL]: 'http://10.0.0.5:9000' }));
      const res = await putConfig(superToken, s3('https://52.216.0.1'));
      expect(res.status).toBe(200);
      expect(await stored(APPROVAL)).toBe('');
    });

    it('leaves the approval to a Super Admin', async () => {
      const res = await putConfig(adminToken, { [APPROVAL]: 'http://10.0.0.5:9000' });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('SUPER_ADMIN_REQUIRED');
    });
  });

  describe('restore from S3', () => {
    const { restoreService } = require('../../src/services/restoreService');

    it('uses an approved private endpoint, and refuses any other private one', async () => {
      await setBackupSettings({ ...s3('http://10.0.0.5:9000'), [APPROVAL]: 'http://10.0.0.5:9000' });

      const agents = await restoreService.pinnedS3Agents({ endpoint: 'http://10.0.0.5:9000' });
      expect(agents.allowPrivateEndpoint).toBe(true);
      expect(agents.httpAgent).toBeDefined();

      await expect(restoreService.pinnedS3Agents({ endpoint: 'http://10.0.0.6:9000' }))
        .rejects.toThrow(/private or internal network address/);
    });

    it('still refuses a private endpoint when nothing is approved', async () => {
      await expect(restoreService.pinnedS3Agents({ endpoint: 'http://10.0.0.5:9000' }))
        .rejects.toThrow(/private or internal network address/);
    });
  });

  describe('POST /test-connection (S3)', () => {
    const endpoint = () => `http://127.0.0.1:${port}`;
    const creds = { bucket: 'backups', access_key: 'key', secret_key: 'secret' };

    it('refuses a private endpoint without approval and never contacts it', async () => {
      const res = await testConnection({ endpoint: endpoint(), ...creds });
      expect(res.body).toMatchObject({ success: false, code: 'S3_PRIVATE_ENDPOINT', origin: endpoint() });
      expect(s3Requests).toBe(0);
    });

    it('runs a real HeadBucket once the origin is approved', async () => {
      const res = await testConnection({ endpoint: endpoint(), ...creds, private_endpoint_approval: endpoint() });
      expect(res.body.success).toBe(true);
      expect(s3Requests).toBeGreaterThan(0);
    });

    it('uses the saved SSL setting for an endpoint without a scheme, as a backup run does', async () => {
      await setBackupSettings({ backup_s3_ssl_enabled: false });
      const bare = `127.0.0.1:${port}`;
      const refused = await testConnection({ endpoint: bare, ...creds });
      // The origin to approve is the HTTP one a backup would connect to.
      expect(refused.body).toMatchObject({ code: 'S3_PRIVATE_ENDPOINT', origin: `http://127.0.0.1:${port}` });

      const res = await testConnection({ endpoint: bare, ...creds, private_endpoint_approval: `http://127.0.0.1:${port}` });
      expect(res.body.success).toBe(true);
      expect(s3Requests).toBeGreaterThan(0);
    });

    it('reports failure for a bucket that does not answer', async () => {
      const res = await testConnection({
        endpoint: endpoint(), ...creds, bucket: 'missing', private_endpoint_approval: endpoint(),
      });
      expect(res.body).toMatchObject({ success: false, code: 'S3_CONNECTION_FAILED' });
    });

    it('does not send the saved secret to an endpoint it was not saved for', async () => {
      await setBackupSettings({ ...s3('https://52.216.0.1'), backup_s3_secret_key: 'saved-secret' });
      const res = await testConnection({
        endpoint: endpoint(), ...creds, secret_key: '••••••••', private_endpoint_approval: endpoint(),
      });
      expect(res.body).toMatchObject({ success: false, code: 'S3_CONFIG_INCOMPLETE' });
      expect(s3Requests).toBe(0);
    });
  });
});
