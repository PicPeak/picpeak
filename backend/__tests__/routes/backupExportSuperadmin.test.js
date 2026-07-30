/**
 * Full-instance export is super_admin only (GHSA-pv6w-rj34-wj9v).
 *
 * GET /api/admin/backup/picpeak/export dumps every table unredacted (bcrypt
 * hashes, 2FA, SMTP/SSO/WhatsApp/webhook/S3 secrets). It was gated only by
 * requirePermission('backup.create'), which the built-in `admin` role holds —
 * so any non-super_admin admin could download the whole database. Pins that
 * `admin` now gets 403 and `super_admin` passes the gate.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-bkexport-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'bkexport-test-secret';

// The export otherwise walks the whole DB and writes a zip — stub it so the
// super_admin happy path is fast and deterministic; the gate is what's tested.
// The route deletes path.dirname(filePath) recursively after download, so the
// stub MUST live in its own dir — a bare os.tmpdir() file would make the route
// wipe the whole temp root (and other jest workers' DB files).
const mockExportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-export-stub-'));
const mockExportPath = path.join(mockExportDir, 'export.picpeak');
fs.writeFileSync(mockExportPath, 'stub');
jest.mock('../../src/services/picpeakExportService', () => ({
  createPicpeak: jest.fn(async () => ({ filePath: mockExportPath })),
}));

const request = require('supertest');
const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const { bootCrmDb, seedMinimal } = require('../integration/helpers/crmDb');

describe('backup export super_admin gate (GHSA-pv6w)', () => {
  let db;
  let cleanup;
  let app;
  let adminToken; let superToken;

  const mkUser = async (username, roleName) => {
    const role = await db('roles').where({ name: roleName }).first();
    const r = await db('admin_users').insert({
      username,
      email: `${username}@example.com`,
      password_hash: await bcrypt.hash('Passw0rd!', 4),
      role_id: role.id,
      is_active: 1,
      created_at: new Date(),
      updated_at: new Date(),
    }).returning('id');
    const id = r[0]?.id ?? r[0];
    return jwt.sign(
      { id, username, type: 'admin', role: roleName, loginTime: Date.now() },
      process.env.JWT_SECRET,
      { expiresIn: '1h', issuer: 'picpeak-auth' },
    );
  };

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    await seedMinimal(db);
    adminToken = await mkUser('limited-admin', 'admin');
    superToken = await mkUser('root-admin', 'super_admin');

    app = express();
    app.use(express.json());
    app.use('/api/admin/backup', require('../../src/routes/adminBackup'));
  }, 120000);

  afterAll(async () => {
    if (cleanup) await cleanup();
    fs.rmSync(mockExportDir, { recursive: true, force: true });
  });

  it('denies the built-in admin role (was: full DB dump)', async () => {
    const res = await request(app)
      .get('/api/admin/backup/picpeak/export')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(403);
  });

  it('allows super_admin', async () => {
    const res = await request(app)
      .get('/api/admin/backup/picpeak/export')
      .set('Authorization', `Bearer ${superToken}`);
    expect(res.status).not.toBe(403);
    expect(res.status).toBeLessThan(500);
  });
});
