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

// A json/text column, read the same way on both engines: PostgreSQL hands
// back an object, SQLite the text.
const parsed = (value) => (typeof value === 'string' ? JSON.parse(value) : value);

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

// Signing codes go out at once rather than through the queue (the way the
// #1465 verification code does), so they are captured here.
const sentCodes = [];
let failNextCode = false;

async function lastMail(type, to) {
  if (type === 'contract_signing_code') {
    const mail = [...sentCodes].reverse().find((m) => m.to === to);
    return mail ? mail.variables : null;
  }
  const row = await db('email_queue').where({ email_type: type, recipient_email: to }).orderBy('id', 'desc').first();
  // PostgreSQL hands a json column back already parsed; SQLite hands text.
  if (!row) return null;
  return typeof row.email_data === 'string' ? JSON.parse(row.email_data) : row.email_data;
}

const linkToken = (mail) => mail.response_url.split('/').pop();

// The public signing routes rate-limit per client address, and this suite
// asks for more codes and signatures than one address may in a minute.
let ipCounter = 0;
const nextIp = () => {
  ipCounter += 1;
  return `198.51.100.${ipCounter % 250}`;
};
const asSigner = (req) => req.set('X-Forwarded-For', nextIp());
const sign = (session, body) => asSigner(request(signingApp).post('/api/public/contract-signing/session/sign'))
  .set('X-Signing-Session', session).send({ consents: [{ key: 'acceptance', accepted: true }], ...body });

async function newContract() {
  const { contract } = await ok(request(contractsApp).post('/api/admin/contracts').set(auth).send({ customerAccountId: customerId }));
  return contract.id;
}

// A signer waits a minute between codes. The suite moves faster than that,
// so it moves the earlier codes back — only the gap, never the hourly cap.
async function minuteLater() {
  const rows = await db('contract_signing_otps').select('id', 'created_at');
  for (const row of rows) {
    const at = new Date(row.created_at).getTime();
    if (Number.isFinite(at)) {
      await db('contract_signing_otps').where({ id: row.id })
        .update({ created_at: new Date(at - 61 * 1000).toISOString() });
    }
  }
}

/** Link → code → session, the way a signer gets in. */
async function verifiedSession(linkTok, email) {
  await minuteLater();
  await ok(asSigner(request(signingApp).post(`/api/public/contract-signing/invite/${linkTok}/code`)));
  const { code } = await lastMail('contract_signing_code', email);
  const verified = await ok(asSigner(request(signingApp).post(`/api/public/contract-signing/invite/${linkTok}/verify`)).send({ code }));
  return verified.sessionToken;
}

beforeAll(async () => {
  ({ db, cleanup, tmpDir } = await bootCrmDb());
  const emailProcessor = require('../../src/services/emailProcessor');
  jest.spyOn(emailProcessor, 'sendTemplateEmail').mockImplementation(async (to, templateKey, variables) => {
    if (templateKey !== 'contract_signing_code') throw new Error(`unexpected immediate email ${templateKey}`);
    if (failNextCode) {
      failNextCode = false;
      throw new Error('Email service not configured');
    }
    sentCodes.push({ to, variables });
    return { success: true };
  });
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
  expect(parsed(doc.manifest).slots.map((s) => s.key)).toEqual(['customer-1', 'customer-2', 'issuer']);
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
  expect(parsed(certificate.manifest).chainHead).toBe(contract.audit_chain_head);

  const overview = await ok(request(contractsApp).get(`/api/admin/contracts/${ids.contract}/signers`).set(auth));
  expect(overview.chain).toEqual(expect.objectContaining({ ok: true }));
  expect(overview.events.map((e) => e.type)).toEqual([
    'sent', 'invited', 'code_sent', 'verified', 'viewed', 'signed', 'invited', 'code_sent', 'verified', 'signed', 'countersigned', 'completed',
  ]);
  expect(JSON.stringify(overview.signers)).not.toMatch(/ip|userAgent/i);

  const { evidence } = await ok(request(contractsApp).get(`/api/admin/contracts/${ids.contract}/signing-evidence`).set(auth));
  expect(evidence.filter((e) => e.ip)).toHaveLength(3);

  expect(await lastMail('contract_fully_signed', customerEmail)).toEqual(expect.objectContaining({ contract_number: contract.contract_number }));
  expect(await lastMail('contract_fully_signed', 'ben@example.com')).toBeTruthy();

  // Every v2 write that touches the contract is in the accounting change
  // history, with who did it and which step it was (#1529). The coverage
  // test proves these go through the recorder; this is what they record.
  const history = await require('../../src/services/accountingHistory')
    .listHistory('contract', ids.contract);
  const steps = history.filter((entry) => entry.entity_type === 'contract')
    .map((entry) => [entry.source, entry.actor.type]);
  expect(steps).toEqual(expect.arrayContaining([
    ['contract.create', 'admin'],
    ['contract.send', 'admin'],
    ['contract.sign.customer', 'customer'],
    ['contract.sign.admin', 'admin'],
  ]));
  // The signature entries name the signer, and carry no evidence.
  const signature = history.find((entry) => entry.source === 'contract.sign.customer');
  expect(signature.actor.name).toBe('Anna Muster');
  expect(JSON.stringify(history)).not.toMatch(/ip_enc|user_agent_enc|198\.51/);
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

test('re-sending a signed v2 contract keeps the signed PDF it has', async () => {
  // The legacy re-stamp builds its stamps from signed_customer_signature_path,
  // which v2 never writes: it would replace the signed record with the
  // unsigned PDF carrying the issuer image alone, and mail that to both
  // parties. A v2 contract re-sends the stored file instead.
  const contract = await db('contracts').where({ id: ids.contract }).first();
  expect(contract.status).toBe('fully_signed');
  const before = { path: contract.signed_pdf_path, sha: contract.signed_pdf_sha256 };
  const bytes = fs.readFileSync(before.path);

  const res = await request(contractsApp).post(`/api/admin/contracts/${ids.contract}/resend-signed`).set(auth);
  expect(res.status).toBe(200);

  const after = await db('contracts').where({ id: ids.contract }).first();
  expect(after.signed_pdf_path).toBe(before.path);
  expect(after.signed_pdf_sha256).toBe(before.sha);
  expect(sha256(fs.readFileSync(after.signed_pdf_path))).toBe(before.sha);
  expect(fs.readFileSync(after.signed_pdf_path).equals(bytes)).toBe(true);
});

test('a wet-signed upload is refused unless its bytes are a PDF and the signer is the only one', async () => {
  const uploadDir = `${process.env.STORAGE_PATH}/uploads/contracts/signed`;
  const count = () => (fs.existsSync(uploadDir) ? fs.readdirSync(uploadDir).length : 0);
  const upload = (session, body, filename = 'signed.pdf') => request(signingApp)
    .post('/api/public/contract-signing/session/upload-signed-pdf')
    .set('X-Signing-Session', session)
    .attach('file', body, { filename, contentType: 'application/pdf' });

  // Two signers: one paper copy can't stand in for both, and accepting it
  // would complete the contract for the other signer too.
  const shared = await newContract();
  await ok(request(contractsApp).put(`/api/admin/contracts/${shared}/signers`).set(auth).send({
    order: 'parallel',
    signers: [{ name: 'Anna Muster', email: customerEmail }, { name: 'Ben Muster', email: 'ben@example.com' }],
  }));
  await ok(request(contractsApp).post(`/api/admin/contracts/${shared}/send`).set(auth));
  const sharedSession = await verifiedSession(linkToken(await lastMail('contract_sent', customerEmail)), customerEmail);
  const before = count();
  const many = await upload(sharedSession, Buffer.from('%PDF-1.4 signed'));
  expect(many.status).toBe(409);
  expect(many.body.code).toBe('MULTIPLE_SIGNERS');
  expect((await db('contracts').where({ id: shared }).first()).status).toBe('sent');
  // The session view doesn't offer the panel either.
  const sharedView = await ok(request(signingApp).get('/api/public/contract-signing/session').set('X-Signing-Session', sharedSession));
  expect(sharedView.contract.allowPdfUpload).toBe(false);

  // One signer, but the bytes are a PNG: refused before it becomes the
  // authoritative signed contract, and nothing is left on disk.
  const single = await newContract();
  await ok(request(contractsApp).post(`/api/admin/contracts/${single}/send`).set(auth));
  const singleSession = await verifiedSession(linkToken(await lastMail('contract_sent', customerEmail)), customerEmail);
  const notPdf = await upload(singleSession, Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]));
  expect(notPdf.status).toBe(400);
  expect(notPdf.body.code).toBe('INVALID_PDF');
  expect((await db('contracts').where({ id: single }).first()).status).toBe('sent');
  expect(count()).toBe(before);

  // A real PDF from the only signer completes it.
  const good = await upload(singleSession, Buffer.from('%PDF-1.4\n%%EOF\n'));
  expect(good.status).toBe(200);
  expect((await db('contracts').where({ id: single }).first()).status).toBe('fully_signed');
});

test('a held link stops requesting codes once the contract is no longer out for signature', async () => {
  // A code request or a verification appends events past the chain head the
  // issued certificate names.
  const id = await newContract();
  await ok(request(contractsApp).post(`/api/admin/contracts/${id}/send`).set(auth));
  const link = linkToken(await lastMail('contract_sent', customerEmail));
  const session = await verifiedSession(link, customerEmail);
  await ok(sign(session, { name: 'Anna Muster', mode: 'typed' }));
  await ok(request(contractsApp).post(`/api/admin/contracts/${id}/countersign`).set(auth).send({ name: 'Studio Admin', mode: 'typed' }));
  const sealed = await db('contracts').where({ id }).first();
  const head = sealed.audit_chain_head;

  const summary = await request(signingApp).get(`/api/public/contract-signing/invite/${link}`);
  expect(summary.status).toBe(410);
  const code = await asSigner(request(signingApp).post(`/api/public/contract-signing/invite/${link}/code`));
  expect(code.status).toBe(410);
  expect((await db('contracts').where({ id }).first()).audit_chain_head).toBe(head);
});

test('parallel wrong codes are still capped at five tries', async () => {
  // Reading the attempt count and writing it back after the compare let every
  // request see the same count, so a burst was not capped at all.
  const id = await newContract();
  await ok(request(contractsApp).post(`/api/admin/contracts/${id}/send`).set(auth));
  const link = linkToken(await lastMail('contract_sent', customerEmail));
  await ok(asSigner(request(signingApp).post(`/api/public/contract-signing/invite/${link}/code`)));
  const { code } = await lastMail('contract_signing_code', customerEmail);
  const wrong = code === '000000' ? '111111' : '000000';

  // Each guess from its own address, so the per-IP limiter doesn't stand in
  // for the per-code cap this test is about.
  const guesses = await Promise.all(Array.from({ length: 8 }, () => asSigner(request(signingApp)
    .post(`/api/public/contract-signing/invite/${link}/verify`)).send({ code: wrong })));
  expect(guesses.every((r) => [400, 429].includes(r.status))).toBe(true);
  const row = await db('contract_signing_otps')
    .where({ signer_id: (await db('contract_signers').where({ contract_id: id, role: 'customer' }).first()).id })
    .orderBy('id', 'desc').first();
  expect(Number(row.attempts)).toBeLessThanOrEqual(5);

  // The code is spent, so the right one no longer opens a session.
  const late = await asSigner(request(signingApp).post(`/api/public/contract-signing/invite/${link}/verify`)).send({ code });
  expect(late.status).toBe(410);
});

test('a code expires, a minute passes between codes, and only five an hour are sent', async () => {
  // The same numbers as the #1465 verification code: 15 minutes, a minute
  // between codes, five an hour. The expiry and the throttle are read back
  // from the row, so this also pins that the timestamps are stored in a
  // shape SQLite reads back (a bare Date lands as "[object Object]", and an
  // unreadable expiry used to count as valid forever).
  const id = await newContract();
  await ok(request(contractsApp).post(`/api/admin/contracts/${id}/send`).set(auth));
  const link = linkToken(await lastMail('contract_sent', customerEmail));
  const signer = await db('contract_signers').where({ contract_id: id, role: 'customer' }).first();
  const codeUrl = `/api/public/contract-signing/invite/${link}/code`;

  const sent = await ok(asSigner(request(signingApp).post(codeUrl)));
  expect(sent).toEqual(expect.objectContaining({ ttlMinutes: 15, resendAfterSeconds: 60 }));
  const { code, ttl_minutes: ttlMinutes } = await lastMail('contract_signing_code', customerEmail);
  expect(ttlMinutes).toBe(15);
  const row = await db('contract_signing_otps').where({ signer_id: signer.id }).orderBy('id', 'desc').first();
  // Whatever the engine hands back — a string on SQLite, a Date on Postgres —
  // it has to be a time this process can read.
  const expiresIn = new Date(row.expires_at).getTime() - Date.now();
  expect(expiresIn).toBeGreaterThan(14 * 60 * 1000);
  expect(expiresIn).toBeLessThanOrEqual(15 * 60 * 1000);

  // A second code inside the minute is refused, with how long to wait, in
  // the shape the shared verification step counts down from.
  const tooSoon = await asSigner(request(signingApp).post(codeUrl));
  expect(tooSoon.status).toBe(429);
  expect(tooSoon.body).toEqual(expect.objectContaining({ code: 'VERIFICATION_RATE_LIMITED' }));
  expect(tooSoon.body.retryAfterSeconds).toBeGreaterThan(0);
  expect(tooSoon.body.retryAfterSeconds).toBeLessThanOrEqual(60);
  expect(tooSoon.headers['retry-after']).toBe(String(tooSoon.body.retryAfterSeconds));

  await db('contract_signing_otps').where({ id: row.id })
    .update({ expires_at: new Date(Date.now() - 60 * 1000).toISOString() });
  const expired = await asSigner(request(signingApp).post(`/api/public/contract-signing/invite/${link}/verify`)).send({ code });
  expect(expired.status).toBe(410);
  expect(expired.body.code).toBe('OTP_EXPIRED');

  // Five codes an hour, counting the one above.
  for (let i = 0; i < 4; i += 1) {
    await minuteLater();
    await ok(asSigner(request(signingApp).post(codeUrl)));
  }
  await minuteLater();
  const capped = await asSigner(request(signingApp).post(codeUrl));
  expect(capped.status).toBe(429);
  expect(capped.body.code).toBe('VERIFICATION_RATE_LIMITED');
  // Until the oldest of the five is an hour old — minutes, not a minute.
  expect(capped.body.retryAfterSeconds).toBeGreaterThan(60);
});

test('a code whose email fails is not a code: the page says so, and the earlier one still works', async () => {
  // Sent at once, the way #1465 sends its code. Queued, a code was "sent"
  // as far as the page could tell even when no mail server would deliver
  // it, and the signer waited for an email that never came.
  const id = await newContract();
  await ok(request(contractsApp).post(`/api/admin/contracts/${id}/send`).set(auth));
  const link = linkToken(await lastMail('contract_sent', customerEmail));
  const signer = await db('contract_signers').where({ contract_id: id, role: 'customer' }).first();
  const codeUrl = `/api/public/contract-signing/invite/${link}/code`;

  await ok(asSigner(request(signingApp).post(codeUrl)));
  const { code: first } = await lastMail('contract_signing_code', customerEmail);
  const before = await db('contract_signing_otps').where({ signer_id: signer.id });

  await minuteLater();
  failNextCode = true;
  const failed = await asSigner(request(signingApp).post(codeUrl));
  expect(failed.status).toBe(503);
  expect(failed.body.code).toBe('EMAIL_UNAVAILABLE');
  // No row for the code nobody received, and it didn't retire the one that
  // did arrive — nor count against the throttle.
  const rows = await db('contract_signing_otps').where({ signer_id: signer.id }).orderBy('id');
  expect(rows).toHaveLength(before.length);
  expect(rows.map((r) => !!r.consumed_at)).toEqual([false]);
  const verified = await ok(asSigner(request(signingApp).post(`/api/public/contract-signing/invite/${link}/verify`)).send({ code: first }));
  expect(verified.sessionToken).toEqual(expect.any(String));
});

test('a new code retires the earlier one once it has gone out', async () => {
  // Pinned on the rows, not on a verify response: verifyOtp only ever reads
  // the newest unconsumed code, so an earlier code fails to verify whether or
  // not it was retired, and a response check can't see the retirement.
  const id = await newContract();
  await ok(request(contractsApp).post(`/api/admin/contracts/${id}/send`).set(auth));
  const link = linkToken(await lastMail('contract_sent', customerEmail));
  const signer = await db('contract_signers').where({ contract_id: id, role: 'customer' }).first();
  const codeUrl = `/api/public/contract-signing/invite/${link}/code`;

  await ok(asSigner(request(signingApp).post(codeUrl)));
  await minuteLater();
  await ok(asSigner(request(signingApp).post(codeUrl)));
  const { code: second } = await lastMail('contract_signing_code', customerEmail);

  const rows = await db('contract_signing_otps').where({ signer_id: signer.id }).orderBy('id');
  expect(rows.map((r) => !!r.consumed_at)).toEqual([true, false]); // earlier retired, newest live
  await ok(asSigner(request(signingApp).post(`/api/public/contract-signing/invite/${link}/verify`)).send({ code: second }));
});

test('a resend can\'t reopen a signer who already answered, and drops their session', async () => {
  const id = await newContract();
  await ok(request(contractsApp).post(`/api/admin/contracts/${id}/send`).set(auth));
  const first = linkToken(await lastMail('contract_sent', customerEmail));
  const session = await verifiedSession(first, customerEmail);
  const signer = await db('contract_signers').where({ contract_id: id, role: 'customer' }).first();

  // The replaced link's session stops working with the link itself.
  await ok(request(contractsApp).post(`/api/admin/contracts/${id}/signers/${signer.id}/resend`).set(auth));
  expect((await request(signingApp).get('/api/public/contract-signing/session')
    .set('X-Signing-Session', session)).status).toBe(401);

  // Once they have signed, a resend can't put them back to `invited`.
  const second = await verifiedSession(linkToken(await lastMail('contract_sent', customerEmail)), customerEmail);
  await ok(sign(second, { name: 'Anna Muster', mode: 'typed' }));
  const resent = await request(contractsApp).post(`/api/admin/contracts/${id}/signers/${signer.id}/resend`).set(auth);
  expect(resent.status).toBe(409);
  expect((await db('contract_signers').where({ id: signer.id }).first()).status).toBe('signed');
});

test('a step that fails after the signature is recorded on the contract, and cleared by the re-send', async () => {
  const id = await newContract();
  await ok(request(contractsApp).post(`/api/admin/contracts/${id}/send`).set(auth));
  const session = await verifiedSession(linkToken(await lastMail('contract_sent', customerEmail)), customerEmail);
  await ok(sign(session, { name: 'Anna Muster', mode: 'typed' }));

  // The completion emails fail; the signature and the seal stand, and the
  // admin is told which step is outstanding instead of it being a log line.
  const emailProcessor = require('../../src/services/emailProcessor');
  const real = emailProcessor.queueEmail;
  const queue = jest.spyOn(emailProcessor, 'queueEmail').mockImplementation((...args) => (
    args[2] === 'contract_fully_signed' ? Promise.reject(new Error('smtp down')) : real(...args)
  ));
  await ok(request(contractsApp).post(`/api/admin/contracts/${id}/countersign`).set(auth)
    .send({ name: 'Studio Admin', mode: 'typed' }));
  queue.mockRestore();

  const sealed = await db('contracts').where({ id }).first();
  expect(sealed.status).toBe('fully_signed');
  expect(sealed.follow_up_failed_at).toBeTruthy();
  expect(sealed.follow_up_error).toMatch(/completion/);
  const overview = await ok(request(contractsApp).get(`/api/admin/contracts/${id}/signers`).set(auth));
  expect(overview.followUp).toEqual(expect.objectContaining({ error: expect.stringMatching(/completion/) }));

  // Re-sending runs the step again and clears the marker.
  expect((await request(contractsApp).post(`/api/admin/contracts/${id}/resend-signed`).set(auth)).status).toBe(200);
  expect((await db('contracts').where({ id }).first()).follow_up_failed_at).toBeNull();
});

test('the send claims the draft it rendered', async () => {
  // Two overlapping sends both pass the draft check; only one can write the
  // frozen text and the PDF, or the loser's freeze lands on a contract the
  // winner has already sent.
  const id = await newContract();
  const [a, b] = await Promise.allSettled([
    request(contractsApp).post(`/api/admin/contracts/${id}/send`).set(auth),
    request(contractsApp).post(`/api/admin/contracts/${id}/send`).set(auth),
  ]);
  const statuses = [a, b].map((r) => (r.status === 'fulfilled' ? r.value.status : 500)).sort();
  expect(statuses[0]).toBe(200);
  expect(statuses[1]).toBeGreaterThanOrEqual(400);
  const contract = await db('contracts').where({ id }).first();
  expect(contract.status).toBe('sent');
  expect(contract.rendered_content_sha256).toBeTruthy();
  // One send, one set of invitations.
  const invitations = await db('contract_signer_invitations')
    .whereIn('signer_id', (await db('contract_signers').where({ contract_id: id })).map((r) => r.id))
    .whereNull('revoked_at');
  expect(invitations).toHaveLength(1);
});

test('an edit saved while the contract is rendering doesn\'t go missing', async () => {
  // The edit passes its own lock check, but the PDF was already rendered from
  // the text before it. The send claims the lock_version it rendered, so it is
  // refused and the admin sends again — rather than mailing a contract whose
  // stored text and stored PDF disagree.
  const id = await newContract();
  const pdfService = require('../../src/services/pdfService');
  const real = pdfService.renderContractWithSlots;
  const render = jest.spyOn(pdfService, 'renderContractWithSlots').mockImplementation(async (ctx) => {
    const out = await real.call(pdfService, ctx);
    await db('contracts').where({ id }).increment('lock_version', 1).update({ title: 'Edited mid-render' });
    return out;
  });
  const res = await request(contractsApp).post(`/api/admin/contracts/${id}/send`).set(auth);
  render.mockRestore();

  expect(res.status).toBe(409);
  expect(res.body.code).toBe('CONTRACT_CHANGED');
  const contract = await db('contracts').where({ id }).first();
  expect(contract.status).toBe('draft');
  expect(contract.rendered_content).toBeNull();

  // Sending again works, and carries the edit.
  expect((await request(contractsApp).post(`/api/admin/contracts/${id}/send`).set(auth)).status).toBe(200);
  expect(JSON.parse((await db('contracts').where({ id }).first()).rendered_content).title).toBe('Edited mid-render');
});

test('signers can\'t be rewritten once the contract is out', async () => {
  const id = await newContract();
  await ok(request(contractsApp).post(`/api/admin/contracts/${id}/send`).set(auth));
  const before = await db('contract_signers').where({ contract_id: id }).orderBy('position');

  const res = await request(contractsApp).put(`/api/admin/contracts/${id}/signers`).set(auth).send({
    signers: [{ name: 'Someone Else', email: 'else@example.com' }],
  });
  expect(res.status).toBe(409);
  const after = await db('contract_signers').where({ contract_id: id }).orderBy('position');
  expect(after.map((r) => r.id)).toEqual(before.map((r) => r.id));
});

test('signing sits behind the contracts flag', async () => {
  await setFlag('contracts', false);
  const res = await request(signingApp).get(`/api/public/contract-signing/invite/${'a'.repeat(64)}`);
  expect(res.status).toBe(403);
  expect(res.body.code).toBe('CONTRACTS_DISABLED');
  await setFlag('contracts', true);
});

test('an invitation whose email fails leaves the signer invitable', async () => {
  // The invitation commits before the mail goes out. When the send fails the
  // signer has to go back to `pending`: left at `invited` with a link nobody
  // received, every later invite skips them and nobody can sign at all.
  const id = await newContract();
  const emailProcessor = require('../../src/services/emailProcessor');
  const real = emailProcessor.queueEmail;
  const queue = jest.spyOn(emailProcessor, 'queueEmail').mockImplementation((...args) => (
    args[2] === 'contract_sent' ? Promise.reject(new Error('smtp down')) : real(...args)
  ));
  const res = await request(contractsApp).post(`/api/admin/contracts/${id}/send`).set(auth);
  queue.mockRestore();
  // The send itself committed: it answers with a warning, not an error, so
  // the admin doesn't send it a second time.
  expect(res.status).toBe(200);
  expect(res.body.data || res.body).toEqual(expect.objectContaining({ invitationFailed: true }));

  const rows = await db('contract_signers').where({ contract_id: id }).orderBy('position');
  expect(rows.map((r) => r.status)).toEqual(['pending', 'pending']);
  const invitations = await db('contract_signer_invitations').whereIn('signer_id', rows.map((r) => r.id));
  expect(invitations.length).toBeGreaterThan(0);
  expect(invitations.every((row) => row.revoked_at)).toBeTruthy();

  // …so the admin's resend reaches them.
  const resent = await request(contractsApp).post(`/api/admin/contracts/${id}/signers/${rows[0].id}/resend`).set(auth);
  expect(resent.status).toBe(200);
  expect((await db('contract_signers').where({ id: rows[0].id }).first()).status).toBe('invited');
});

// ---------------------------------------------------------------------
// Slice 1 of the #1446 plan — fixes to shipped behaviour
// ---------------------------------------------------------------------

test('a co-signer never sees the account holder\'s email or company', async () => {
  // buildPublicView's `recipient` block is the account holder's. Handing it
  // to every verified signer gives a second signer the address their
  // co-signer's login codes go to — one signer's authentication data,
  // reaching another.
  await db('customer_accounts').where({ id: customerId }).update({ company_name: 'Muster Fotografie AG' });
  const id = await newContract();
  await ok(request(contractsApp).put(`/api/admin/contracts/${id}/signers`).set(auth).send({
    order: 'parallel',
    signers: [{ name: 'Anna Muster', email: customerEmail }, { name: 'Ben Muster', email: 'ben@example.com' }],
  }));
  await ok(request(contractsApp).post(`/api/admin/contracts/${id}/send`).set(auth));

  const view = async (session) => (await ok(request(signingApp).get('/api/public/contract-signing/session')
    .set('X-Signing-Session', session))).contract;

  const co = await view(await verifiedSession(linkToken(await lastMail('contract_sent', 'ben@example.com')), 'ben@example.com'));
  expect(co.recipient.email).toBeNull();
  expect(co.recipient.companyName).toBeNull();
  expect(JSON.stringify(co.recipient)).not.toContain(customerEmail);
  expect(JSON.stringify(co.recipient)).not.toContain('Muster Fotografie AG');
  // The display name stays: it is printed in the contract they are reading.
  expect(co.recipient.displayName).toBeTruthy();
  // Their own address is still theirs to see.
  expect(co.signing.email).toBe('ben@example.com');

  // The account holder still sees their own block whole.
  const holder = await view(await verifiedSession(linkToken(await lastMail('contract_sent', customerEmail)), customerEmail));
  expect(holder.recipient.email).toBe(customerEmail);
  expect(holder.recipient.companyName).toBe('Muster Fotografie AG');
  await db('customer_accounts').where({ id: customerId }).update({ company_name: null });
});

test('an admin\'s paper copy has to say which signers it carries', async () => {
  // The upload completes the contract for everyone, and the server cannot
  // read whose signatures the paper bears. The customer's own upload is
  // refused outright on a multi-signer contract; the admin keeps the
  // capability but has to state what the copy covers, on the record.
  const id = await newContract();
  await ok(request(contractsApp).put(`/api/admin/contracts/${id}/signers`).set(auth).send({
    order: 'parallel',
    signers: [{ name: 'Anna Muster', email: customerEmail }, { name: 'Ben Muster', email: 'ben@example.com' }],
  }));
  await ok(request(contractsApp).post(`/api/admin/contracts/${id}/send`).set(auth));
  const rows = await db('contract_signers').where({ contract_id: id, role: 'customer' }).orderBy('position');

  const coverage = await ok(request(contractsApp).get(`/api/admin/contracts/${id}/paper-signature-coverage`).set(auth));
  expect(coverage.signers.map((s) => s.id)).toEqual(rows.map((r) => r.id));

  const upload = (covers) => {
    const req = request(contractsApp).post(`/api/admin/contracts/${id}/upload-signed-pdf`).set(auth);
    if (covers !== undefined) req.field('coversSignerIds', JSON.stringify(covers));
    return req.attach('file', Buffer.from('%PDF-1.4\n%%EOF\n'), { filename: 'paper.pdf', contentType: 'application/pdf' });
  };

  const none = await upload(undefined);
  expect(none.status).toBe(400);
  expect(none.body.code).toBe('SIGNERS_NOT_COVERED');
  const partial = await upload([rows[0].id]);
  expect(partial.status).toBe(400);
  expect(partial.body.code).toBe('SIGNERS_NOT_COVERED');
  expect(partial.body.details.missingSignerIds).toEqual([rows[1].id]);
  // A refused upload leaves the contract out for signature and writes no file.
  expect((await db('contracts').where({ id }).first()).status).toBe('sent');

  const foreign = await upload([rows[0].id, rows[1].id + 9999]);
  expect(foreign.status).toBe(400);
  expect(foreign.body.code).toBe('SIGNER_NOT_FOUND');

  const all = await upload([rows[0].id, rows[1].id]);
  expect(all.status).toBe(200);
  expect((await db('contracts').where({ id }).first()).status).toBe('fully_signed');
  const event = await db('contract_signing_events').where({ contract_id: id, event_type: 'wet_upload' }).first();
  const payload = parsed(event.payload);
  expect(payload.coversSignerIds).toEqual([rows[0].id, rows[1].id]);
  expect(payload.uploadedByAdminId).toBe(adminId);
  // Ids only — no names, no addresses.
  expect(JSON.stringify(payload)).not.toContain('Muster');
  expect(JSON.stringify(payload)).not.toContain('@');
});

test('a paper copy is refused once any signer has signed in the browser', async () => {
  // The upload replaces the signed PDF and completes the contract, so an
  // electronic signature already on the record would be discarded without
  // the log saying so. The admin counter-signs in the browser instead.
  const uploadPaper = (id, covers) => request(contractsApp).post(`/api/admin/contracts/${id}/upload-signed-pdf`).set(auth)
    .field('coversSignerIds', JSON.stringify(covers))
    .attach('file', Buffer.from('%PDF-1.4\n%%EOF\n'), { filename: 'paper.pdf', contentType: 'application/pdf' });

  // One of two parallel signers has signed: the contract is still `sent`.
  const partialId = await newContract();
  await ok(request(contractsApp).put(`/api/admin/contracts/${partialId}/signers`).set(auth).send({
    order: 'parallel',
    signers: [{ name: 'Anna Muster', email: customerEmail }, { name: 'Ben Muster', email: 'ben@example.com' }],
  }));
  await ok(request(contractsApp).post(`/api/admin/contracts/${partialId}/send`).set(auth));
  const annaSession = await verifiedSession(linkToken(await lastMail('contract_sent', customerEmail)), customerEmail);
  await ok(sign(annaSession, { name: 'Anna Muster', mode: 'typed' }));
  const before = await db('contracts').where({ id: partialId }).first();
  const rows = await db('contract_signers').where({ contract_id: partialId, role: 'customer' }).orderBy('position');

  const coverage = await ok(request(contractsApp).get(`/api/admin/contracts/${partialId}/paper-signature-coverage`).set(auth));
  expect(coverage.electronicSignaturePresent).toBe(true);
  const refused = await uploadPaper(partialId, [rows[1].id]);
  expect(refused.status).toBe(409);
  expect(refused.body.code).toBe('ELECTRONIC_SIGNATURE_PRESENT');
  const after = await db('contracts').where({ id: partialId }).first();
  expect(after.status).toBe('sent');
  expect(after.signed_pdf_path).toBe(before.signed_pdf_path);
  expect(await db('contract_signing_events').where({ contract_id: partialId, event_type: 'wet_upload' }).first()).toBeUndefined();
  expect((await db('contract_signers').where({ id: rows[0].id }).first()).status).toBe('signed');

  // Every signer has signed and only the counter-signature is missing.
  const signedId = await newContract();
  await ok(request(contractsApp).post(`/api/admin/contracts/${signedId}/send`).set(auth));
  const session = await verifiedSession(linkToken(await lastMail('contract_sent', customerEmail)), customerEmail);
  await ok(sign(session, { name: 'Anna Muster', mode: 'typed' }));
  const allSigned = await ok(request(contractsApp).get(`/api/admin/contracts/${signedId}/paper-signature-coverage`).set(auth));
  expect(allSigned).toEqual({ signers: [], electronicSignaturePresent: true });
  const res = await uploadPaper(signedId, []);
  expect(res.status).toBe(409);
  expect(res.body.code).toBe('ELECTRONIC_SIGNATURE_PRESENT');
  expect((await db('contracts').where({ id: signedId }).first()).status).toBe('signed_by_customer');
});

test('the coverage says no electronic signature is present before anyone signs', async () => {
  const id = await newContract();
  await ok(request(contractsApp).post(`/api/admin/contracts/${id}/send`).set(auth));
  const coverage = await ok(request(contractsApp).get(`/api/admin/contracts/${id}/paper-signature-coverage`).set(auth));
  expect(coverage.electronicSignaturePresent).toBe(false);
  expect(coverage.signers).toHaveLength(1);
});

test('the signing certificate can be downloaded once it exists', async () => {
  const id = await newContract();
  await ok(request(contractsApp).post(`/api/admin/contracts/${id}/send`).set(auth));

  // Nothing to download before the contract is complete — and that is a
  // 404 with its own code, not an empty PDF.
  const early = await request(contractsApp).get(`/api/admin/contracts/${id}/certificate`).set(auth);
  expect(early.status).toBe(404);
  expect(early.body.code).toBe('CERTIFICATE_MISSING');

  const session = await verifiedSession(linkToken(await lastMail('contract_sent', customerEmail)), customerEmail);
  await ok(sign(session, { name: 'Anna Muster', mode: 'typed' }));
  await ok(request(contractsApp).post(`/api/admin/contracts/${id}/countersign`).set(auth).send({ name: 'Studio Admin', mode: 'typed' }));

  const res = await request(contractsApp).get(`/api/admin/contracts/${id}/certificate`).set(auth);
  expect(res.status).toBe(200);
  expect(res.headers['content-type']).toBe('application/pdf');
  expect(res.headers['x-content-type-options']).toBe('nosniff');
  expect(res.headers['content-disposition']).toMatch(/^attachment;/);
  expect(res.body.slice(0, 5).toString()).toBe('%PDF-');
  // The bytes are the artifact that was recorded, not a fresh render.
  const stored = await db('generated_documents')
    .where({ doc_type: 'contract', doc_id: id, kind: 'audit' }).orderBy('id', 'desc').first();
  expect(sha256(res.body)).toBe(sha256(fs.readFileSync(stored.path)));
});

// ---------------------------------------------------------------------
// Slice 2 of the #1446 plan — the isolation and permission matrix.
//
// The suite above signs happy paths with a super_admin and one customer.
// These are the refusals: another signer's session, another contract's
// attachment, a revoked link, a reused key, and the evidence view behind
// the permission that is supposed to guard it.
// ---------------------------------------------------------------------

test('a verified session reaches only its own contract\'s attachments', async () => {
  const attachments = require('../../src/services/contract/attachments');
  const mine = await newContract();
  const theirs = await newContract();

  // A real attachment, on the OTHER contract: the session is scoped to its
  // own contract, not merely to "an attachment that exists".
  const pdf = await PDFDocument.create();
  pdf.addPage([200, 200]);
  const { attachment } = await attachments.storeAttachment(Buffer.from(await pdf.save()), { name: 'Terms' }, adminId);
  await db.transaction((trx) => attachments.writeContractAttachments(trx, theirs, [
    { attachmentId: attachment.id, delivery: 'separate' },
  ]));
  expect(await attachments.loadContractAttachments(theirs)).toHaveLength(1);

  await ok(request(contractsApp).post(`/api/admin/contracts/${mine}/send`).set(auth));
  const session = await verifiedSession(linkToken(await lastMail('contract_sent', customerEmail)), customerEmail);

  const res = await asSigner(request(signingApp).get(`/api/public/contract-signing/session/attachments/${attachment.id}`))
    .set('X-Signing-Session', session);
  expect(res.status).toBe(404);
});

test('a signer\'s session signs their own slot and nobody else\'s', async () => {
  const id = await newContract();
  await ok(request(contractsApp).put(`/api/admin/contracts/${id}/signers`).set(auth).send({
    order: 'parallel',
    signers: [{ name: 'Anna Muster', email: customerEmail }, { name: 'Ben Muster', email: 'ben@example.com' }],
  }));
  await ok(request(contractsApp).post(`/api/admin/contracts/${id}/send`).set(auth));
  const benSession = await verifiedSession(linkToken(await lastMail('contract_sent', 'ben@example.com')), 'ben@example.com');

  // Ben signs — with Anna's name, which is the closest a signer can come to
  // signing someone else's slot. The slot follows the session, not the name.
  await ok(sign(benSession, { name: 'Anna Muster', mode: 'typed' }));

  const rows = await db('contract_signers').where({ contract_id: id, role: 'customer' }).orderBy('position');
  expect(rows.map((r) => [r.slot_key, r.status])).toEqual([
    ['customer-1', 'invited'], ['customer-2', 'signed'],
  ]);
  expect((await db('contracts').where({ id }).first()).status).toBe('sent');
});

test('a revoked link is refused before it can ask for a code', async () => {
  const id = await newContract();
  await ok(request(contractsApp).post(`/api/admin/contracts/${id}/send`).set(auth));
  const link = linkToken(await lastMail('contract_sent', customerEmail));
  const signer = await db('contract_signers').where({ contract_id: id, role: 'customer' }).first();
  // A resend revokes the earlier link.
  await ok(request(contractsApp).post(`/api/admin/contracts/${id}/signers/${signer.id}/resend`).set(auth));

  const before = await db('contract_signing_events').where({ contract_id: id, event_type: 'code_sent' });
  const code = await asSigner(request(signingApp).post(`/api/public/contract-signing/invite/${link}/code`));
  expect(code.status).toBe(410);
  expect(code.body.code).toBe('SIGNING_LINK_REVOKED');
  // No mail, and nothing appended to the chain for a link that is gone.
  expect(await db('contract_signing_events').where({ contract_id: id, event_type: 'code_sent' }))
    .toHaveLength(before.length);
});

test('a signing key replayed with different details is refused, not answered "done"', async () => {
  const id = await newContract();
  await ok(request(contractsApp).post(`/api/admin/contracts/${id}/send`).set(auth));
  const session = await verifiedSession(linkToken(await lastMail('contract_sent', customerEmail)), customerEmail);

  await ok(sign(session, { name: 'Anna Muster', mode: 'typed', idempotencyKey: 'reuse-1' }));
  // The same key is what makes a resend after a lost response safe…
  const replay = await ok(sign(session, { name: 'Anna Muster', mode: 'typed', idempotencyKey: 'reuse-1' }));
  expect(replay.replayed).toBe(true);

  // …but it must not vouch for a signature nobody made under that name.
  const different = await sign(session, { name: 'Someone Else', mode: 'typed', idempotencyKey: 'reuse-1' });
  expect(different.status).toBe(409);
  expect(different.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
  const mode = await sign(session, { name: 'Anna Muster', mode: 'drawn', signatureDataUrl: PNG, idempotencyKey: 'reuse-1' });
  expect(mode.status).toBe(409);
  expect(mode.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
  // Still exactly one signature, with the details it was recorded with.
  const signer = await db('contract_signers').where({ contract_id: id, role: 'customer' }).first();
  expect(signer.signature_mode).toBe('typed');
  expect(require('../../src/utils/fieldEncryption').tryDecrypt(signer.name_enc)).toBe('Anna Muster');
});

test('the evidence view needs contracts.manage, and every opening is logged', async () => {
  // The suite signs everything as a super_admin, so the permission that is
  // supposed to guard decrypted IP addresses and user agents was unpinned.
  const readOnlyAdmin = await db('admin_users').insert({
    username: 'contracts-reader', email: 'contracts-reader@example.com',
    password_hash: 'x', is_active: 1, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  }).returning('id');
  const readerId = typeof readOnlyAdmin[0] === 'object' ? readOnlyAdmin[0].id : readOnlyAdmin[0];
  const role = await db('roles').insert({
    name: 'contracts_reader', display_name: 'Contracts Reader', is_system: 0, priority: 10,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  }).returning('id');
  const roleId = typeof role[0] === 'object' ? role[0].id : role[0];
  const viewPerm = await db('permissions').where({ name: 'contracts.view' }).first();
  await db('role_permissions').insert({ role_id: roleId, permission_id: viewPerm.id });
  await db('admin_users').where({ id: readerId }).update({ role_id: roleId });
  // The middleware caches role → permissions for a minute; the role was
  // created after this suite's first request filled it.
  require('../../src/middleware/permissions').clearPermissionCache();
  const readerAuth = { Authorization: `Bearer ${mintAdminToken(readerId)}` };

  const denied = await request(contractsApp).get(`/api/admin/contracts/${ids.contract}/signing-evidence`).set(readerAuth);
  expect(denied.status).toBe(403);
  // A read-only role still reads the contract itself — this is about the
  // evidence, not about the contract being invisible.
  expect((await request(contractsApp).get(`/api/admin/contracts/${ids.contract}`).set(readerAuth)).status).toBe(200);

  const opened = () => db('activity_logs').where({ activity_type: 'contract_signing_evidence_viewed' });
  const before = await opened();
  const allowed = await ok(request(contractsApp).get(`/api/admin/contracts/${ids.contract}/signing-evidence`).set(auth));
  expect(allowed.evidence.some((e) => e.ip)).toBe(true);
  const after = await opened();
  expect(after.length).toBe(before.length + 1);
  const latest = await opened().orderBy('id', 'desc').first();
  expect(parsed(latest.metadata).contractId).toBe(ids.contract);
});
