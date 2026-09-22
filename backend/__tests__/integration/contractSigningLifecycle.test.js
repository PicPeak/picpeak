/**
 * Signatures v2, the rest of the #1446 plan (slices 3 onwards).
 *
 * Same harness as contractSigningV2.test.js — real admin and public routes →
 * services → the full core-migration run — with its helpers copied, so the
 * two suites stay independent and each stays readable on its own.
 */

const fs = require('fs');
const request = require('supertest');
const { PDFDocument } = require('pdf-lib');
const {
  bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken, buildRouteApp,
} = require('./helpers/crmDb');

jest.setTimeout(120000);

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

const prevCwd = process.cwd();
const auth = { get Authorization() { return `Bearer ${token}`; } };

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

const sentCodes = [];

async function lastMail(type, to) {
  if (type === 'contract_signing_code') {
    const mail = [...sentCodes].reverse().find((m) => m.to === to);
    return mail ? mail.variables : null;
  }
  const row = await db('email_queue').where({ email_type: type, recipient_email: to }).orderBy('id', 'desc').first();
  if (!row) return null;
  return typeof row.email_data === 'string' ? JSON.parse(row.email_data) : row.email_data;
}

const linkToken = (mail) => mail.response_url.split('/').pop();

let ipCounter = 0;
const nextIp = () => {
  ipCounter += 1;
  return `198.51.100.${ipCounter % 250}`;
};
const asSigner = (req) => req.set('X-Forwarded-For', nextIp());
const sign = (session, body) => asSigner(request(signingApp).post('/api/public/contract-signing/session/sign'))
  .set('X-Signing-Session', session).send({ accepted: true, ...body });
const sessionView = async (session) => (await ok(asSigner(request(signingApp).get('/api/public/contract-signing/session'))
  .set('X-Signing-Session', session))).contract;

async function newContract(extra = {}) {
  const { contract } = await ok(request(contractsApp).post('/api/admin/contracts').set(auth)
    .send({ customerAccountId: customerId, ...extra }));
  return contract.id;
}

async function sendContract(id) {
  return ok(request(contractsApp).post(`/api/admin/contracts/${id}/send`).set(auth));
}

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

async function verifiedSession(linkTok, email) {
  await minuteLater();
  await ok(asSigner(request(signingApp).post(`/api/public/contract-signing/invite/${linkTok}/code`)));
  const { code } = await lastMail('contract_signing_code', email);
  const verified = await ok(asSigner(request(signingApp).post(`/api/public/contract-signing/invite/${linkTok}/verify`)).send({ code }));
  return verified.sessionToken;
}

/** A sent single-signer contract and its first signer's session. */
async function sentWithSession(extra = {}) {
  const id = await newContract(extra);
  await sendContract(id);
  const session = await verifiedSession(linkToken(await lastMail('contract_sent', customerEmail)), customerEmail);
  return { id, session };
}

const eventTypes = async (id) => (await db('contract_signing_events').where({ contract_id: id }).orderBy('seq'))
  .map((e) => e.event_type);

/** A one-page PDF in the attachment library. */
async function libraryAttachment(name) {
  const attachments = require('../../src/services/contract/attachments');
  const pdf = await PDFDocument.create();
  pdf.addPage([200, 200]).drawText(name);
  const { attachment } = await attachments.storeAttachment(Buffer.from(await pdf.save()), { name }, adminId);
  return attachment;
}

beforeAll(async () => {
  ({ db, cleanup, tmpDir } = await bootCrmDb());
  const emailProcessor = require('../../src/services/emailProcessor');
  jest.spyOn(emailProcessor, 'sendTemplateEmail').mockImplementation(async (to, templateKey, variables) => {
    if (templateKey !== 'contract_signing_code') throw new Error(`unexpected immediate email ${templateKey}`);
    sentCodes.push({ to, variables });
    return { success: true };
  });
  process.chdir(tmpDir);
  db.client.pool.acquireTimeoutMillis = 2000;
  ({ adminId, customerId } = await seedMinimal(db));
  await assignAdminRole(db, adminId, 'super_admin');
  token = mintAdminToken(adminId);
  await setFlag('contracts', true);
  await setFlag('quotes', true);
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

// ---------------------------------------------------------------------
// Slice 3 — the attachment manifest is bound into the signature
// ---------------------------------------------------------------------

describe('the manifest is bound into the signature', () => {
  test('the send freezes the manifest hash; each signature carries it', async () => {
    const attachments = require('../../src/services/contract/attachments');
    const terms = await libraryAttachment('Terms');
    const id = await newContract();
    await db.transaction((trx) => attachments.writeContractAttachments(trx, id, [
      { attachmentId: terms.id, delivery: 'separate' },
    ]));
    await sendContract(id);

    const contract = await db('contracts').where({ id }).first();
    const doc = await db('generated_documents').where({ doc_type: 'contract', doc_id: id, kind: 'unsigned' }).first();
    const manifest = parsed(doc.manifest);
    expect(manifest.attachments.map((a) => [a.name, a.delivery])).toEqual([['Terms', 'separate']]);
    expect(contract.attachment_manifest_sha256).toBe(attachments.manifestSha256(manifest));
    const sent = await db('contract_signing_events').where({ contract_id: id, event_type: 'sent' }).first();
    expect(parsed(sent.payload).manifestSha256).toBe(contract.attachment_manifest_sha256);

    const session = await verifiedSession(linkToken(await lastMail('contract_sent', customerEmail)), customerEmail);
    // The signer is shown what they are about to be bound to.
    const view = await sessionView(session);
    expect(view.manifest.sha256).toBe(contract.attachment_manifest_sha256);
    expect(view.manifest.attachments).toEqual([
      expect.objectContaining({ name: 'Terms', delivery: 'separate', pages: 1, sha256: manifest.attachments[0].sha256 }),
    ]);
    expect(view.contentSha256).toBe(contract.rendered_content_sha256);

    await ok(sign(session, { name: 'Anna Muster', mode: 'typed' }));
    const signer = await db('contract_signers').where({ contract_id: id, role: 'customer' }).first();
    expect(signer.manifest_sha256).toBe(contract.attachment_manifest_sha256);
    const signed = await db('contract_signing_events').where({ contract_id: id, event_type: 'signed' }).first();
    expect(parsed(signed.payload).manifestSha256).toBe(contract.attachment_manifest_sha256);

    await ok(request(contractsApp).post(`/api/admin/contracts/${id}/countersign`).set(auth).send({ name: 'Studio Admin', mode: 'typed' }));
    const issuer = await db('contract_signers').where({ contract_id: id, role: 'issuer' }).first();
    expect(issuer.manifest_sha256).toBe(contract.attachment_manifest_sha256);
  });

  test('a manifest changed after send is refused under the lock, and nothing is written', async () => {
    const { id, session } = await sentWithSession();
    const doc = await db('generated_documents').where({ doc_type: 'contract', doc_id: id, kind: 'unsigned' }).first();
    const manifest = parsed(doc.manifest);
    manifest.attachments.push({ attachmentId: 999, name: 'Smuggled', sha256: 'f'.repeat(64), delivery: 'separate', pages: 1 });
    await db('generated_documents').where({ id: doc.id }).update({ manifest: JSON.stringify(manifest) });
    const before = await eventTypes(id);

    const res = await sign(session, { name: 'Anna Muster', mode: 'typed' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CONTRACT_CHANGED');
    expect((await db('contract_signers').where({ contract_id: id, role: 'customer' }).first()).status).toBe('invited');
    expect((await db('contracts').where({ id }).first()).signed_pdf_path).toBeFalsy();
    expect(await eventTypes(id)).toEqual(before);
  });

  test('frozen content changed after send is refused the same way', async () => {
    const { id, session } = await sentWithSession();
    const contract = await db('contracts').where({ id }).first();
    const snapshot = parsed(contract.rendered_content);
    snapshot.title = 'Something else';
    await db('contracts').where({ id }).update({ rendered_content: JSON.stringify(snapshot) });

    const res = await sign(session, { name: 'Anna Muster', mode: 'typed' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CONTRACT_CHANGED');
    expect((await db('contract_signers').where({ contract_id: id, role: 'customer' }).first()).status).toBe('invited');
  });

  test('editing the source quote after send changes nothing a signer signs', async () => {
    // Guard: 1445's snapshot format 2 already froze the price, so this passes
    // without slice 3. It pins that the binding covers the price.
    const quoteService = require('../../src/services/quoteService');
    const contractService = require('../../src/services/contractService');
    const quoteId = await quoteService.createQuote({
      customerAccountId: customerId,
      currency: 'CHF',
      vatRate: 8.1,
      eventName: 'Bound shoot',
      lineItems: [{ position: 1, quantity: 1, description: 'Reportage, 8h', unit_price_minor: 240000, discount_percent: 0, parent_position: null }],
    }, adminId);
    await quoteService.sendQuote(quoteId, adminId);
    await quoteService.adminAcceptQuote(quoteId, adminId);
    const { contractId: id } = await contractService.createFromQuote(quoteId, adminId);
    await sendContract(id);
    const sent = await db('contracts').where({ id }).first();
    const session = await verifiedSession(linkToken(await lastMail('contract_sent', customerEmail)), customerEmail);
    const beforeView = await sessionView(session);

    // The quote changes under the sent contract: price and total.
    await db('quote_line_items').where({ quote_id: quoteId }).update({ unit_price_minor: 1, line_total_minor: 1, description: 'Changed' });
    await db('quotes').where({ id: quoteId }).update({ total_amount_minor: 1, net_amount_minor: 1 });

    const afterView = await sessionView(session);
    expect(afterView.commercial).toEqual(beforeView.commercial);
    expect(afterView.commercial.totals.grossMinor).not.toBe(1);
    await ok(sign(session, { name: 'Anna Muster', mode: 'typed' }));
    const after = await db('contracts').where({ id }).first();
    expect(after.rendered_content_sha256).toBe(sent.rendered_content_sha256);
    expect(after.rendered_content).toBe(sent.rendered_content);
    const signer = await db('contract_signers').where({ contract_id: id, role: 'customer' }).first();
    expect(signer.content_sha256).toBe(sent.rendered_content_sha256);
  });

  test('the certificate prints the manifest hash', async () => {
    const { id, session } = await sentWithSession();
    await ok(sign(session, { name: 'Anna Muster', mode: 'typed' }));
    const pdfService = require('../../src/services/pdf/signingCertificate');
    const spy = jest.spyOn(pdfService, 'renderSigningCertificate');
    await ok(request(contractsApp).post(`/api/admin/contracts/${id}/countersign`).set(auth).send({ name: 'Studio Admin', mode: 'typed' }));
    const contract = await db('contracts').where({ id }).first();
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({
      hashes: expect.objectContaining({ manifest: contract.attachment_manifest_sha256 }),
    }));
    spy.mockRestore();
    expect(contract.attachment_manifest_sha256).toMatch(/^[0-9a-f]{64}$/);
    const stored = await db('generated_documents').where({ doc_type: 'contract', doc_id: id, kind: 'audit' }).first();
    expect(fs.existsSync(stored.path)).toBe(true);
  });
});

// ---------------------------------------------------------------------
// Slice 4 — lifecycle: `viewed`, `expired`, the sweep, derived progress
// ---------------------------------------------------------------------

const daysAgo = (days) => new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
const dateOnly = (iso) => iso.slice(0, 10);

async function twoSigners(id, order = 'parallel') {
  await ok(request(contractsApp).put(`/api/admin/contracts/${id}/signers`).set(auth).send({
    order,
    signers: [{ name: 'Anna Muster', email: customerEmail }, { name: 'Ben Muster', email: 'ben@example.com' }],
  }));
}

describe('lifecycle', () => {
  test('opening the contract is logged once per session, however many requests race', async () => {
    const { id, session } = await sentWithSession();
    await Promise.all(Array.from({ length: 5 }, () => sessionView(session)));
    await sessionView(session);
    const viewed = await db('contract_signing_events').where({ contract_id: id, event_type: 'viewed' });
    expect(viewed).toHaveLength(1);
    const signer = await db('contract_signers').where({ contract_id: id, role: 'customer' }).first();
    expect(Number(viewed[0].signer_id)).toBe(signer.id);
    expect((await require('../../src/services/contract/signingEvents').verifyChain(id)).ok).toBe(true);

    // A new session is a new opening.
    const second = await verifiedSession(linkToken(await lastMail('contract_sent', customerEmail)), customerEmail);
    await sessionView(second);
    expect(await db('contract_signing_events').where({ contract_id: id, event_type: 'viewed' })).toHaveLength(2);
  });

  test('nothing is logged for an opening once the contract is no longer out for signature', async () => {
    const { id, session } = await sentWithSession();
    // Sign without opening the view first: the session is still valid and
    // unviewed, but the contract is signed_by_customer now.
    await ok(sign(session, { name: 'Anna Muster', mode: 'typed' }));
    const before = await db('contracts').where({ id }).first();
    expect(before.status).toBe('signed_by_customer');
    await sessionView(session);
    expect(await db('contract_signing_events').where({ contract_id: id, event_type: 'viewed' })).toHaveLength(0);
    expect((await db('contracts').where({ id }).first()).audit_chain_head).toBe(before.audit_chain_head);
  });

  test('the sweep expires a contract once, however many replicas run it', async () => {
    const { runContractSigningSweep } = require('../../src/services/contract/expiry');
    const id = await newContract();
    await twoSigners(id);
    await sendContract(id);
    const annaLink = linkToken(await lastMail('contract_sent', customerEmail));
    const benLink = linkToken(await lastMail('contract_sent', 'ben@example.com'));
    const anna = await verifiedSession(annaLink, customerEmail);
    await ok(sign(anna, { name: 'Anna Muster', mode: 'typed' }));
    // The contract's window closed three weeks ago (valid_until + 14 days).
    await db('contracts').where({ id }).update({ valid_until: dateOnly(daysAgo(21)) });
    const notices = async () => db('email_queue').where({ email_type: 'contract_expired_admin_notification' });
    const noticesBefore = (await notices()).length;

    const runs = await Promise.all([runContractSigningSweep(), runContractSigningSweep()]);
    expect(runs.reduce((sum, r) => sum + r.expired, 0)).toBeGreaterThanOrEqual(1);

    expect((await db('contracts').where({ id }).first()).status).toBe('expired');
    const expired = await db('contract_signing_events').where({ contract_id: id, event_type: 'expired' });
    expect(expired).toHaveLength(1);
    const annaRow = await db('contract_signers').where({ contract_id: id, position: 1 }).first();
    expect(parsed(expired[0].payload).signedSignerIds).toEqual([annaRow.id]);
    expect((await notices()).length).toBe(noticesBefore + 1);
    expect((await require('../../src/services/contract/signingEvents').verifyChain(id)).ok).toBe(true);

    // A third run finds nothing to do for it.
    await runContractSigningSweep();
    expect(await db('contract_signing_events').where({ contract_id: id, event_type: 'expired' })).toHaveLength(1);

    // Every link says why it stopped working.
    for (const link of [annaLink, benLink]) {
      const res = await asSigner(request(signingApp).get(`/api/public/contract-signing/invite/${link}`));
      expect(res.status).toBe(410);
      expect(res.body.code).toBe('CONTRACT_EXPIRED');
    }
    expect((await asSigner(request(signingApp).get('/api/public/contract-signing/session')).set('X-Signing-Session', anna)).status).toBe(401);
  });

  test('a contract still inside its window is left alone', async () => {
    const { runContractSigningSweep } = require('../../src/services/contract/expiry');
    const id = await newContract();
    await sendContract(id);
    await db('contracts').where({ id }).update({ valid_until: dateOnly(daysAgo(10)) });
    await runContractSigningSweep();
    expect((await db('contracts').where({ id }).first()).status).toBe('sent');
  });

  test('the portal path refuses once the time to sign has run out', async () => {
    const signingV2 = require('../../src/services/contract/signingV2');
    const customer = await db('customer_accounts').where({ id: customerId }).first();

    // Past its deadline, before the hourly sweep flipped it.
    const late = await newContract();
    await sendContract(late);
    await db('contracts').where({ id: late }).update({ valid_until: dateOnly(daysAgo(20)) });
    await expect(signingV2.portalSigningAccess(customer, late)).rejects.toMatchObject({ code: 'CONTRACT_EXPIRED' });
    expect(await db('contract_signing_events').where({ contract_id: late, event_type: 'verified' })).toHaveLength(0);

    // And once it has.
    await require('../../src/services/contract/expiry').runContractSigningSweep();
    expect((await db('contracts').where({ id: late }).first()).status).toBe('expired');
    await expect(signingV2.portalSigningAccess(customer, late)).rejects.toMatchObject({ code: 'CONTRACT_EXPIRED' });
  });

  test('codes and sessions are removed a month after they end, not before', async () => {
    const { runContractSigningSweep } = require('../../src/services/contract/expiry');
    const { session } = await sentWithSession();
    const signerRow = await db('contract_signing_sessions').where({ session_hash: require('crypto').createHash('sha256').update(session).digest('hex') }).first();
    const otp = await db('contract_signing_otps').where({ signer_id: signerRow.signer_id }).orderBy('id', 'desc').first();
    await db('contract_signing_otps').where({ id: otp.id }).update({ expires_at: daysAgo(31) });
    await db('contract_signing_sessions').where({ id: signerRow.id }).update({ expires_at: daysAgo(29) });

    await runContractSigningSweep();
    expect(await db('contract_signing_otps').where({ id: otp.id }).first()).toBeUndefined();
    expect(await db('contract_signing_sessions').where({ id: signerRow.id }).first()).toBeTruthy();

    await db('contract_signing_sessions').where({ id: signerRow.id }).update({ expires_at: daysAgo(31) });
    await runContractSigningSweep();
    expect(await db('contract_signing_sessions').where({ id: signerRow.id }).first()).toBeUndefined();
  });

  test('the lists say how far the signers have got', async () => {
    const id = await newContract();
    await twoSigners(id);
    await sendContract(id);
    const anna = await verifiedSession(linkToken(await lastMail('contract_sent', customerEmail)), customerEmail);
    await ok(sign(anna, { name: 'Anna Muster', mode: 'typed' }));
    const { contracts } = await ok(request(contractsApp).get('/api/admin/contracts?pageSize=200').set(auth));
    const row = contracts.find((c) => c.id === id);
    expect(row.status).toBe('sent');
    expect(row.signerProgress).toEqual({ signed: 1, total: 2 });
  });
});
