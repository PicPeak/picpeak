/**
 * System Health must not call the evidence key healthy while most of the
 * evidence on the install was written under another one (#1446).
 *
 * The panel used to read the key id off the newest `contract_signers.name_enc`
 * row alone. A key that changed part-way — a rotated env var, a restore that
 * brought back a different key file — leaves the older rows unreadable, and
 * one fresh row was enough to report "all fine" over them.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-evidencekey-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'evidencekey-test-secret';
// A key in the environment, so the panel reports a known id rather than
// generating a file the suite would have to clean up.
process.env.PICPEAK_EVIDENCE_KEY = 'b'.repeat(64);

const request = require('supertest');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const { bootCrmDb, seedMinimal, buildRouteApp } = require('../integration/helpers/crmDb');

describe('GET /admin/system-health/failures — the signing evidence key (#1446)', () => {
  let db; let cleanup; let app; let token; let fieldEncryption; let contractId;

  const nowIso = () => new Date().toISOString();

  /** A signer row, optionally with its evidence written under another key. */
  const signer = (position, { foreignKeyId = null } = {}) => {
    const value = (plain) => {
      const encrypted = fieldEncryption.encrypt(plain);
      return foreignKeyId ? encrypted.replace(/^v1:[0-9a-f]{8}:/, `v1:${foreignKeyId}:`) : encrypted;
    };
    return db('contract_signers').insert({
      contract_id: contractId,
      position,
      role: 'customer',
      slot_key: `customer-${position}`,
      name_enc: value('Anna Muster'),
      email_enc: value('anna@example.com'),
      ip_enc: value('198.51.100.7'),
      status: 'signed',
      created_at: nowIso(),
      updated_at: nowIso(),
    });
  };

  const health = async () => {
    const res = await request(app).get('/admin/system-health/failures').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    return (res.body.data || res.body).evidenceKey;
  };

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    const { customerId } = await seedMinimal(db);
    fieldEncryption = require('../../src/utils/fieldEncryption');
    fieldEncryption._resetForTests();

    const inserted = await db('contracts').insert({
      contract_number: 'K-EK-1', customer_account_id: customerId, title: 'Evidence key', status: 'sent', language: 'de',
      issue_date: nowIso().slice(0, 10), created_at: nowIso(),
    }).returning('id');
    contractId = inserted[0]?.id ?? inserted[0];

    const role = await db('roles').where({ name: 'super_admin' }).first();
    const admin = await db('admin_users').insert({
      username: 'evidencekey-admin',
      email: 'evidencekey-admin@example.com',
      password_hash: await bcrypt.hash('Passw0rd!', 4),
      role_id: role.id,
      is_active: 1,
      created_at: nowIso(),
      updated_at: nowIso(),
    }).returning('id');
    const adminId = admin[0]?.id ?? admin[0];
    token = jwt.sign(
      { id: adminId, username: 'evidencekey-admin', type: 'admin', role: 'super_admin', loginTime: Date.now() },
      process.env.JWT_SECRET,
      { expiresIn: '1h', issuer: 'picpeak-auth' },
    );

    app = buildRouteApp('/admin/system-health', require('../../src/routes/adminSystemHealth'));
  }, 120000);

  afterAll(async () => { await cleanup(); });
  afterEach(async () => { await db('contract_signers').del(); });

  it('reports the key in use and no mismatch when there is no evidence yet', async () => {
    const evidenceKey = await health();
    expect(evidenceKey.source).toBe('env');
    expect(evidenceKey.keyId).toMatch(/^[0-9a-f]{8}$/);
    expect(evidenceKey.storedValues).toBe(0);
    expect(evidenceKey.matchesStored).toBeNull();
  });

  it('counts every encrypted column, not just the newest name', async () => {
    await signer(1);
    const evidenceKey = await health();
    // name, email and IP of one signer.
    expect(evidenceKey.storedValues).toBe(3);
    expect(evidenceKey.storedValuesUnderCurrentKey).toBe(3);
    expect(evidenceKey.matchesStored).toBe(true);
    expect(evidenceKey.storedKeyIds).toEqual({ [evidenceKey.keyId]: 3 });
  });

  it('sees older rows under a different key behind a readable newest row', async () => {
    // The shape the old check missed: the newest row is fine, everything
    // before it is unreadable.
    await signer(1, { foreignKeyId: 'deadbeef' });
    await signer(2, { foreignKeyId: 'deadbeef' });
    await signer(3);

    const evidenceKey = await health();
    expect(evidenceKey.matchesStored).toBe(false);
    expect(evidenceKey.storedKeyId).toBe('deadbeef');
    expect(evidenceKey.storedValues).toBe(9);
    expect(evidenceKey.storedValuesUnderCurrentKey).toBe(3);
    expect(evidenceKey.storedKeyIds.deadbeef).toBe(6);
    // Never the key itself.
    expect(JSON.stringify(evidenceKey)).not.toContain(process.env.PICPEAK_EVIDENCE_KEY);
  });
});
