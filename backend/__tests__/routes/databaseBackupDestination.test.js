/**
 * Manual database backup must not honour a caller-supplied destination
 * (GHSA-jw8m-43r2-jqrm).
 *
 * POST /api/admin/database-backup/backup forwarded req.body straight into
 * databaseBackupService.backup(), which merges options over its config:
 *   const { destinationPath = '/backup/database', ... } = { ...config, ...options }
 * `destinationPath` is not a persistable setting (the /config allowlist only
 * accepts `database_backup_*` keys), so the request body was its ONLY source.
 *
 * The `admin` role holds backup.create but neither settings.edit nor
 * backup.restore — so it could aim a full DB dump (bcrypt hashes, gallery
 * password hashes, encrypted SMTP creds) at the PUBLIC /uploads static mount
 * (server.js mounts it with no auth middleware) and fetch it unauthenticated.
 *
 * Pins that destinationPath from the body is ignored, while the legitimate
 * knobs still pass through.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-dbbackup-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'dbbackup-test-secret';

// Capture what the route hands the service; never run a real backup.
const mockBackup = jest.fn(async () => ({ success: true }));
jest.mock('../../src/services/databaseBackup', () => ({
  databaseBackupService: {
    get isRunning() { return false; },
    backup: (...args) => mockBackup(...args),
  },
}));

const request = require('supertest');
const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const { bootCrmDb, seedMinimal } = require('../integration/helpers/crmDb');

describe('manual database backup destination (GHSA-jw8m)', () => {
  let db; let cleanup; let app; let adminToken;

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    await seedMinimal(db);

    const role = await db('roles').where({ name: 'admin' }).first();
    const r = await db('admin_users').insert({
      username: 'limited-admin',
      email: 'limited-admin@example.com',
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

    app = express();
    app.use(express.json());
    app.use('/api/admin/database-backup', require('../../src/routes/adminDatabaseBackup'));
  }, 120000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  beforeEach(() => mockBackup.mockClear());

  it('ignores a caller-supplied destinationPath', async () => {
    const res = await request(app)
      .post('/api/admin/database-backup/backup')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ destinationPath: '/app/storage/uploads' });

    expect(res.status).toBe(200);
    // Give the fire-and-forget call a tick to land.
    await new Promise((resolve) => setImmediate(resolve));
    expect(mockBackup).toHaveBeenCalled();
    const opts = mockBackup.mock.calls[0][0];
    expect(opts).not.toHaveProperty('destinationPath');
    expect(JSON.stringify(opts)).not.toContain('uploads');
  });

  it('still forwards the legitimate backup knobs', async () => {
    const res = await request(app)
      .post('/api/admin/database-backup/backup')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ compress: false, validateIntegrity: false, destinationPath: '/tmp/evil' });

    expect(res.status).toBe(200);
    await new Promise((resolve) => setImmediate(resolve));
    const opts = mockBackup.mock.calls[0][0];
    expect(opts.compress).toBe(false);
    expect(opts.validateIntegrity).toBe(false);
    expect(opts).not.toHaveProperty('destinationPath');
  });

  it('omits absent knobs entirely so service/config defaults still apply', async () => {
    const res = await request(app)
      .post('/api/admin/database-backup/backup')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});

    expect(res.status).toBe(200);
    await new Promise((resolve) => setImmediate(resolve));
    // An explicit `{compress: undefined}` would override config on spread —
    // absent keys must simply not be present.
    expect(mockBackup.mock.calls[0][0]).toEqual({});
  });
});
