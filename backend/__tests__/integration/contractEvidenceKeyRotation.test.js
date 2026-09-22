/**
 * Evidence key ring and rotation (#1446, plan slice 9).
 *
 * Pins: old keys named in PICPEAK_EVIDENCE_KEYS_OLD or kept as
 * evidence.key.<keyId> still open their values; a malformed old key is a
 * boot error; scripts/rotate-evidence-key.js moves every value to the current
 * key, keeps the replaced generated key file under its id, is resumable, and
 * changes no hash — the content, the PDFs, the event chain and the
 * certificate stay exactly as they were.
 */

const fs = require('fs');
const path = require('path');
const request = require('supertest');
const {
  bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken, buildRouteApp,
} = require('./helpers/crmDb');

jest.setTimeout(120000);

let db;
let cleanup;
let tmpDir;
let customerEmail;
let token;
let contractsApp;
let signingApp;
let fieldEncryption;
const prevCwd = process.cwd();
const prevKeys = { key: process.env.PICPEAK_EVIDENCE_KEY, old: process.env.PICPEAK_EVIDENCE_KEYS_OLD };
const auth = { get Authorization() { return `Bearer ${token}`; } };
const sentCodes = [];
const KEY_B = 'b'.repeat(64);
const KEY_C = 'c'.repeat(64);

async function ok(req) {
  const res = await req;
  if (![200, 201].includes(res.status)) throw new Error(`${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

let ip = 0;
const asSigner = (req) => req.set('X-Forwarded-For', `198.51.100.${(ip += 1) % 250}`);

/** A sent contract and a verified session for its one signer. */
async function sentWithSession() {
  const { contract } = await ok(request(contractsApp).post('/api/admin/contracts').set(auth)
    .send({ customerAccountId: (await db('customer_accounts').first()).id }));
  await ok(request(contractsApp).post(`/api/admin/contracts/${contract.id}/send`).set(auth));
  const mail = await db('email_queue').where({ email_type: 'contract_sent', recipient_email: customerEmail }).orderBy('id', 'desc').first();
  const data = typeof mail.email_data === 'string' ? JSON.parse(mail.email_data) : mail.email_data;
  const link = data.response_url.split('/').pop();
  await ok(asSigner(request(signingApp).post(`/api/public/contract-signing/invite/${link}/code`)));
  const { code } = sentCodes[sentCodes.length - 1];
  const { sessionToken } = await ok(asSigner(request(signingApp).post(`/api/public/contract-signing/invite/${link}/verify`)).send({ code }));
  return { id: contract.id, session: sessionToken };
}

/** One completed contract and one declined one: every evidence column in use. */
async function evidenceOnRecord() {
  const signed = await sentWithSession();
  await ok(asSigner(request(signingApp).post('/api/public/contract-signing/session/sign')).set('X-Signing-Session', signed.session)
    .set('User-Agent', 'rotation-test').send({ name: 'Anna Muster', mode: 'typed', consents: [{ key: 'acceptance', accepted: true }] }));
  await ok(request(contractsApp).post(`/api/admin/contracts/${signed.id}/countersign`).set(auth).send({ name: 'Studio Admin', mode: 'typed' }));
  const declined = await sentWithSession();
  await ok(asSigner(request(signingApp).post('/api/public/contract-signing/session/decline')).set('X-Signing-Session', declined.session)
    .send({ reason: 'Wrong date' }));
  return signed.id;
}

beforeAll(async () => {
  delete process.env.PICPEAK_EVIDENCE_KEY;
  delete process.env.PICPEAK_EVIDENCE_KEYS_OLD;
  ({ db, cleanup, tmpDir } = await bootCrmDb());
  const emailProcessor = require('../../src/services/emailProcessor');
  jest.spyOn(emailProcessor, 'sendTemplateEmail').mockImplementation(async (to, key, variables) => {
    sentCodes.push({ to, code: variables.code });
    return { success: true };
  });
  process.chdir(tmpDir);
  const { adminId, customerId } = await seedMinimal(db);
  await assignAdminRole(db, adminId, 'super_admin');
  token = mintAdminToken(adminId);
  for (const key of ['contracts']) {
    const updated = await db('feature_flags').where({ key }).update({ value: true });
    if (!updated) await db('feature_flags').insert({ key, value: true });
  }
  require('../../src/middleware/requireFeatureFlag').invalidateFeatureFlagCache();
  customerEmail = (await db('customer_accounts').where({ id: customerId }).first()).email.toLowerCase();
  await db('customer_accounts').where({ id: customerId }).update({ first_name: 'Anna', last_name: 'Muster' });
  const profile = await db('business_profile').where({ id: 1 }).first();
  if (profile) await db('business_profile').where({ id: 1 }).update({ email: 'studio@example.com', company_name: 'Studio Test' });
  else await db('business_profile').insert({ id: 1, email: 'studio@example.com', company_name: 'Studio Test' });
  contractsApp = buildRouteApp('/api/admin/contracts', require('../../src/routes/adminContracts'));
  signingApp = buildRouteApp('/api/public/contract-signing', require('../../src/routes/publicContractSigning'));
  fieldEncryption = require('../../src/utils/fieldEncryption');
  fieldEncryption._resetForTests();
}, 120000);

afterAll(async () => {
  for (const [name, value] of [['PICPEAK_EVIDENCE_KEY', prevKeys.key], ['PICPEAK_EVIDENCE_KEYS_OLD', prevKeys.old]]) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  fieldEncryption._resetForTests();
  process.chdir(prevCwd);
  if (cleanup) await cleanup();
});

const COLUMNS = ['name_enc', 'email_enc', 'ip_enc', 'user_agent_enc', 'decline_reason_enc'];
const values = async () => (await db('contract_signers').orderBy('id')).flatMap((row) => COLUMNS.map((c) => row[c]).filter(Boolean));

test('rotation moves every value to the new key and changes no hash', async () => {
  const id = await evidenceOnRecord();
  const signers = await db('contract_signers').orderBy('id');
  const plainBefore = signers.map((row) => COLUMNS.map((c) => fieldEncryption.tryDecrypt(row[c])));
  expect(plainBefore.flat()).toContain('Wrong date');
  const keyA = fieldEncryption.keyInfo().keyId;
  const snapshot = async () => ({
    contract: await db('contracts').where({ id }).first('rendered_content_sha256', 'pdf_sha256', 'signed_pdf_sha256', 'audit_chain_head', 'attachment_manifest_sha256'),
    events: (await db('contract_signing_events').where({ contract_id: id }).orderBy('seq')).map((e) => e.event_hash),
    signers: (await db('contract_signers').where({ contract_id: id }).orderBy('id'))
      .map((row) => [row.content_sha256, row.document_sha256, row.signature_sha256, row.manifest_sha256]),
  });
  const before = await snapshot();

  // A new key from the env var: until the rotation keeps the generated file,
  // the values written under it can't be read.
  process.env.PICPEAK_EVIDENCE_KEY = KEY_B;
  fieldEncryption._resetForTests();
  const keyB = fieldEncryption.keyInfo().keyId;
  expect(fieldEncryption.tryDecrypt(signers[0].name_enc)).toBeNull();

  const { rotate } = require('../../scripts/rotate-evidence-key');
  const dry = await rotate({ db, fieldEncryption, dryRun: true });
  expect(dry.remaining).toBeGreaterThan(0);
  expect(dry.renamedKeyFile).toBeNull();
  expect((await values()).every((v) => v.startsWith(`v1:${keyA}:`))).toBe(true);

  const result = await rotate({ db, fieldEncryption });
  expect(result.renamedKeyFile).toBe(`evidence.key.${keyA}`);
  expect(fs.existsSync(path.join(process.env.STORAGE_PATH, 'business-docs', 'keys', `evidence.key.${keyA}`))).toBe(true);
  expect(result.unreadable).toBe(0);
  expect(result.remaining).toBe(0);
  expect(result.rewritten).toBe(dry.remaining);
  expect((await values()).every((v) => v.startsWith(`v1:${keyB}:`))).toBe(true);
  const after = await db('contract_signers').orderBy('id');
  expect(after.map((row) => COLUMNS.map((c) => fieldEncryption.tryDecrypt(row[c])))).toEqual(plainBefore);

  // Nothing that is hashed changed: ciphertext is in no hash.
  expect(await snapshot()).toEqual(before);
  expect((await require('../../src/services/contract/signingEvents').verifyChain(id)).ok).toBe(true);
  expect((await require('../../src/services/contract/integrity').integrityReport(id)).ok).toBe(true);

  // Resumable and idempotent: a second run finds nothing to do.
  expect(await rotate({ db, fieldEncryption })).toEqual(expect.objectContaining({ rewritten: 0, remaining: 0, renamedKeyFile: null }));
});

test('an old key named in PICPEAK_EVIDENCE_KEYS_OLD still opens its values', () => {
  process.env.PICPEAK_EVIDENCE_KEY = KEY_B;
  fieldEncryption._resetForTests();
  const underB = fieldEncryption.encrypt('Ben Muster');
  process.env.PICPEAK_EVIDENCE_KEY = KEY_C;
  fieldEncryption._resetForTests();
  expect(fieldEncryption.tryDecrypt(underB)).toBeNull();
  process.env.PICPEAK_EVIDENCE_KEYS_OLD = `${'d'.repeat(64)}, ${KEY_B}`;
  fieldEncryption._resetForTests();
  expect(fieldEncryption.decrypt(underB)).toBe('Ben Muster');
  // New values always go under the current key.
  expect(fieldEncryption.encrypt('x').startsWith(`v1:${fieldEncryption.keyInfo().keyId}:`)).toBe(true);
  expect(fieldEncryption.ringKeyIds()[0]).toBe(fieldEncryption.keyInfo().keyId);
});

test('a malformed old key is refused at boot', () => {
  process.env.PICPEAK_EVIDENCE_KEY = KEY_C;
  process.env.PICPEAK_EVIDENCE_KEYS_OLD = `${KEY_B},${'e'.repeat(63)}`;
  fieldEncryption._resetForTests();
  expect(fieldEncryption.keyProblemAtBoot()).toMatch(/PICPEAK_EVIDENCE_KEYS_OLD \(entry 2\)/);
  process.env.PICPEAK_EVIDENCE_KEYS_OLD = KEY_B;
  expect(fieldEncryption.keyProblemAtBoot()).toBeNull();
});
