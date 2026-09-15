/**
 * Signatures v2 (#1446).
 *
 * Real admin + public routes → services → SQLite with the full
 * core-migration run (helpers/crmDb). Pins:
 *   - sending invites each signer with their own link, stored only as a hash;
 *   - a link shows nothing about the customer until the emailed code is
 *     entered; codes are single use and wrong ones are counted;
 *   - sequential signers sign in order, each into their own slot, and a
 *     signature is idempotent per key;
 *   - the issuer counter-signs only after every customer; completion seals
 *     the contract, draws the band, issues the certificate, and the event
 *     chain verifies;
 *   - IP address and user agent are stored encrypted and only the evidence
 *     view returns them;
 *   - declining, resending and cancelling withdraw links;
 *   - the portal opens a session for the signer with the customer's email.
 */

const crypto = require('crypto');
const fs = require('fs');
const request = require('supertest');
const { PDFDocument } = require('pdf-lib');
const {
  bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken, buildRouteApp,
} = require('./helpers/crmDb');

jest.setTimeout(120000);

let db;
let cleanup;
let tmpDir;
let adminId;
let customerId;
let customerEmail;
let token;
let contractsApp;
let signingApp;
const ids = {};

const prevCwd = process.cwd();
const auth = { get Authorization() { return `Bearer ${token}`; } };
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const PNG = `data:image/png;base64,${'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='}`;

async function setFlag(key, value) {
  const updated = await db('feature_flags').where({ key }).update({ value });
  if (!updated) await db('feature_flags').insert({ key, value });
  require('../../src/middleware/requireFeatureFlag').invalidateFeatureFlagCache();
}

async function ok(req, status = [200, 201]) {
  const res = await req;
  if (!status.includes(res.status)) throw new Error(`${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

async function lastMail(type, to) {
  const row = await db('email_queue').where({ email_type: type, recipient_email: to }).orderBy('id', 'desc').first();
  return row ? JSON.parse(row.email_data) : null;
}

const linkToken = (mail) => mail.response_url.split('/').pop();
const sign = (session, body) => request(signingApp).post('/api/public/contract-signing/session/sign')
  .set('X-Signing-Session', session).send({ accepted: true, ...body });

async function newContract() {
  const { contract } = await ok(request(contractsApp).post('/api/admin/contracts').set(auth).send({ customerAccountId: customerId }));
  return contract.id;
}

/** Link → code → session, the way a signer gets in. */
async function verifiedSession(linkTok, email) {
  await ok(request(signingApp).post(`/api/public/contract-signing/invite/${linkTok}/code`));
  const { code } = await lastMail('contract_signing_code', email);
  const verified = await ok(request(signingApp).post(`/api/public/contract-signing/invite/${linkTok}/verify`).send({ code }));
  return verified.sessionToken;
}

beforeAll(async () => {
  ({ db, cleanup, tmpDir } = await bootCrmDb());
  process.chdir(tmpDir);
  db.client.pool.acquireTimeoutMillis = 2000;
  ({ adminId, customerId } = await seedMinimal(db));
  await assignAdminRole(db, adminId, 'super_admin');
  token = mintAdminToken(adminId);
  await setFlag('contracts', true);
  customerEmail = (await db('customer_accounts').where({ id: customerId }).first()).email.toLowerCase();
  await db('customer_accounts').where({ id: customerId }).update({ first_name: 'Anna', last_name: 'Muster' });
  const profile = await db('business_profile').where({ id: 1 }).first();
  if (profile) await db('business_profile').where({ id: 1 }).update({ email: 'studio@example.com', company_name: 'Studio Test' });
  else await db('business_profile').insert({ id: 1, email: 'studio@example.com', company_name: 'Studio Test' });

  contractsApp = buildRouteApp('/api/admin/contracts', require('../../src/routes/adminContracts'));
  signingApp = buildRouteApp('/api/public/contract-signing', require('../../src/routes/publicContractSigning'));
}, 120000);

afterAll(async () => {
  process.chdir(prevCwd);
  if (cleanup) await cleanup();
});

test('sending invites each signer with their own link, stored only as a hash', async () => {
  ids.contract = await newContract();
  const overview = await ok(request(contractsApp).put(`/api/admin/contracts/${ids.contract}/signers`).set(auth).send({
    order: 'sequential',
    signers: [{ name: 'Anna Muster', email: customerEmail }, { name: 'Ben Muster', email: 'ben@example.com' }],
  }));
  expect(overview.signers.map((s) => [s.role, s.name, s.status])).toEqual([
    ['customer', 'Anna Muster', 'pending'], ['customer', 'Ben Muster', 'pending'], ['issuer', 'Studio Test', 'pending'],
  ]);

  await ok(request(contractsApp).post(`/api/admin/contracts/${ids.contract}/send`).set(auth));
  const contract = await db('contracts').where({ id: ids.contract }).first();
  expect(contract).toEqual(expect.objectContaining({ status: 'sent', signing_version: 2, signing_order: 'sequential' }));
  const rows = await db('contract_signers').where({ contract_id: ids.contract }).orderBy('position');
  expect(rows.map((r) => r.status)).toEqual(['invited', 'pending', 'pending']);
  expect(rows[0].name_enc).toMatch(/^v1:/);
  expect(rows[0].name_enc).not.toContain('Anna');

  const mail = await lastMail('contract_sent', customerEmail);
  ids.link1 = linkToken(mail);
  const invitation = await db('contract_signer_invitations').where({ signer_id: rows[0].id }).first();
  expect(invitation.token_hash).toBe(sha256(ids.link1));
  expect(await lastMail('contract_sent', 'ben@example.com')).toBeNull();
  expect(await db('contract_action_tokens').where({ contract_id: ids.contract })).toHaveLength(0);

  const doc = await db('generated_documents').where({ doc_type: 'contract', doc_id: ids.contract, kind: 'unsigned' }).first();
  expect(JSON.parse(doc.manifest).slots.map((s) => s.key)).toEqual(['customer-1', 'customer-2', 'issuer']);
});

test('a link shows nothing about the customer until the emailed code is entered', async () => {
  const summary = await ok(request(signingApp).get(`/api/public/contract-signing/invite/${ids.link1}`));
  expect(summary.signer.maskedEmail).toMatch(/\*\*\*/);
  expect(JSON.stringify(summary)).not.toContain(customerEmail);
  expect(JSON.stringify(summary)).not.toContain('Anna');
  expect((await request(signingApp).get('/api/public/contract-signing/session')).status).toBe(401);

  await ok(request(signingApp).post(`/api/public/contract-signing/invite/${ids.link1}/code`));
  const { code } = await lastMail('contract_signing_code', customerEmail);
  const wrong = code === '000000' ? '111111' : '000000';
  const miss = await request(signingApp).post(`/api/public/contract-signing/invite/${ids.link1}/verify`).send({ code: wrong });
  expect(miss.status).toBe(400);
  expect(miss.body.code).toBe('OTP_WRONG');
  const { sessionToken } = await ok(request(signingApp).post(`/api/public/contract-signing/invite/${ids.link1}/verify`).send({ code }));
  ids.session1 = sessionToken;
  const reused = await request(signingApp).post(`/api/public/contract-signing/invite/${ids.link1}/verify`).send({ code });
  expect(reused.status).toBe(410);

  const { contract } = await ok(request(signingApp).get('/api/public/contract-signing/session').set('X-Signing-Session', sessionToken));
  expect(contract.signing).toEqual(expect.objectContaining({ canSign: true, name: 'Anna Muster', verifiedVia: 'otp' }));
  expect(contract.signing.signers).toHaveLength(3);
  expect(contract.signedCustomerIp).toBeUndefined();
});

test('sequential signers sign in order, and a signature is idempotent per key', async () => {
  const rows = await db('contract_signers').where({ contract_id: ids.contract }).orderBy('position');
  const early = await require('../../src/services/contract/signers').createSession(rows[1].id, 'otp');
  const tooEarly = await sign(early.token, { name: 'Ben Muster', mode: 'typed' });
  expect(tooEarly.status).toBe(409);
  expect(tooEarly.body.code).toBe('NOT_YOUR_TURN');

  const first = await ok(sign(ids.session1, { name: 'Anna Muster', mode: 'drawn', signatureDataUrl: PNG, idempotencyKey: 'k-1' }));
  expect(first.status).toBe('sent');
  const replay = await ok(sign(ids.session1, { name: 'Anna Muster', mode: 'drawn', signatureDataUrl: PNG, idempotencyKey: 'k-1' }));
  expect(replay.replayed).toBe(true);
  const again = await sign(ids.session1, { name: 'Anna Muster', mode: 'drawn', signatureDataUrl: PNG, idempotencyKey: 'k-2' });
  expect(again.body.code).toBe('ALREADY_SIGNED');

  const pending = await request(contractsApp).post(`/api/admin/contracts/${ids.contract}/countersign`).set(auth).send({ name: 'Admin', mode: 'typed' });
  expect(pending.status).toBe(409);
  expect(pending.body.code).toBe('CUSTOMERS_PENDING');

  // Now Ben is invited; he signs with a typed name.
  const benLink = linkToken(await lastMail('contract_sent', 'ben@example.com'));
  const benSession = await verifiedSession(benLink, 'ben@example.com');
  const second = await ok(sign(benSession, { name: 'Ben Muster', mode: 'typed' }));
  expect(second.status).toBe('signed_by_customer');

  const signed = await db('contract_signers').where({ contract_id: ids.contract, role: 'customer' });
  for (const row of signed) {
    expect(row.status).toBe('signed');
    expect(row.ip_enc).toMatch(/^v1:/);
    expect(row.document_sha256).toMatch(/^[0-9a-f]{64}$/);
  }
  const notice = await lastMail('contract_signed_admin_notification', 'studio@example.com');
  expect(notice.contract_number).toBeTruthy();
});

test('the issuer counter-signs last; completion seals it and the chain verifies', async () => {
  const unsigned = await db('generated_documents').where({ doc_type: 'contract', doc_id: ids.contract, kind: 'unsigned' }).first();
  const done = await ok(request(contractsApp).post(`/api/admin/contracts/${ids.contract}/countersign`).set(auth)
    .send({ name: 'Studio Admin', mode: 'typed' }));
  expect(done.status).toBe('fully_signed');

  const contract = await db('contracts').where({ id: ids.contract }).first();
  expect(contract.sealed_at).toBeTruthy();
  const final = fs.readFileSync(contract.signed_pdf_path);
  expect(sha256(final)).toBe(contract.signed_pdf_sha256);
  expect((await PDFDocument.load(final)).getPageCount()).toBe(Number(unsigned.pages));
  const certificate = await db('generated_documents').where({ doc_type: 'contract', doc_id: ids.contract, kind: 'audit' }).first();
  expect(JSON.parse(certificate.manifest).chainHead).toBe(contract.audit_chain_head);

  const overview = await ok(request(contractsApp).get(`/api/admin/contracts/${ids.contract}/signers`).set(auth));
  expect(overview.chain).toEqual(expect.objectContaining({ ok: true }));
  expect(overview.events.map((e) => e.type)).toEqual([
    'sent', 'invited', 'code_sent', 'verified', 'signed', 'invited', 'code_sent', 'verified', 'signed', 'countersigned', 'completed',
  ]);
  expect(JSON.stringify(overview.signers)).not.toMatch(/ip|userAgent/i);

  const { evidence } = await ok(request(contractsApp).get(`/api/admin/contracts/${ids.contract}/signing-evidence`).set(auth));
  expect(evidence.filter((e) => e.ip)).toHaveLength(3);

  expect(await lastMail('contract_fully_signed', customerEmail)).toEqual(expect.objectContaining({ contract_number: contract.contract_number }));
  expect(await lastMail('contract_fully_signed', 'ben@example.com')).toBeTruthy();
});

test('a signer can decline, and every link stops working', async () => {
  const id = await newContract();
  await ok(request(contractsApp).post(`/api/admin/contracts/${id}/send`).set(auth));
  const link = linkToken(await lastMail('contract_sent', customerEmail));
  const session = await verifiedSession(link, customerEmail);
  const declined = await ok(request(signingApp).post('/api/public/contract-signing/session/decline')
    .set('X-Signing-Session', session).send({ reason: 'Datum passt nicht' }));
  expect(declined.status).toBe('declined');
  expect((await db('contracts').where({ id }).first()).status).toBe('declined');
  expect((await request(signingApp).get(`/api/public/contract-signing/invite/${link}`)).status).toBe(410);
  expect((await request(signingApp).get('/api/public/contract-signing/session').set('X-Signing-Session', session)).status).toBe(401);
  expect(await lastMail('contract_declined_admin_notification', 'studio@example.com')).toEqual(expect.objectContaining({ reason: 'Datum passt nicht' }));
});

test('resending replaces a link, and cancelling withdraws it', async () => {
  const id = await newContract();
  await ok(request(contractsApp).post(`/api/admin/contracts/${id}/send`).set(auth));
  const first = linkToken(await lastMail('contract_sent', customerEmail));
  const signer = await db('contract_signers').where({ contract_id: id, role: 'customer' }).first();
  await ok(request(contractsApp).post(`/api/admin/contracts/${id}/signers/${signer.id}/resend`).set(auth));
  const second = linkToken(await lastMail('contract_sent', customerEmail));
  expect(second).not.toBe(first);
  const revoked = await request(signingApp).get(`/api/public/contract-signing/invite/${first}`);
  expect(revoked.status).toBe(410);
  expect(revoked.body.code).toBe('SIGNING_LINK_REVOKED');
  await ok(request(signingApp).get(`/api/public/contract-signing/invite/${second}`));

  await ok(request(contractsApp).post(`/api/admin/contracts/${id}/cancel`).set(auth));
  expect((await request(signingApp).get(`/api/public/contract-signing/invite/${second}`)).status).toBe(410);
});

test('the portal opens a session for the signer with the customer\'s email', async () => {
  const signingV2 = require('../../src/services/contract/signingV2');
  const id = await newContract();
  await ok(request(contractsApp).post(`/api/admin/contracts/${id}/send`).set(auth));
  const customer = await db('customer_accounts').where({ id: customerId }).first();
  const access = await signingV2.portalSigningAccess(customer, id);
  expect(access.mode).toBe('session');
  const { contract } = await ok(request(signingApp).get('/api/public/contract-signing/session').set('X-Signing-Session', access.sessionToken));
  expect(contract.signing.verifiedVia).toBe('portal');

  await expect(signingV2.portalSigningAccess({ ...customer, id: customer.id + 999 }, id)).rejects.toThrow(/not found/i);
});

test('signing sits behind the contracts flag', async () => {
  await setFlag('contracts', false);
  const res = await request(signingApp).get(`/api/public/contract-signing/invite/${'a'.repeat(64)}`);
  expect(res.status).toBe(403);
  expect(res.body.code).toBe('CONTRACTS_DISABLED');
  await setFlag('contracts', true);
});
