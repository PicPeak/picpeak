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
let templatesApp;

const prevCwd = process.cwd();
const auth = { get Authorization() { return `Bearer ${token}`; } };

async function setFlag(key, value) {
  const updated = await db('feature_flags').where({ key }).update({ value });
  if (!updated) await db('feature_flags').insert({ key, value });
  require('../../src/middleware/requireFeatureFlag').invalidateFeatureFlagCache();
}

async function setSetting(key, value) {
  const { upsertAppSetting } = require('../../src/utils/appSettings');
  await upsertAppSetting(key, JSON.stringify(value), 'crm');
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
  .set('X-Signing-Session', session).send({ consents: [{ key: 'acceptance', accepted: true }], ...body });
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
  templatesApp = buildRouteApp('/api/admin/contract-templates', require('../../src/routes/adminContractTemplates'));
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

  test('a snapshot lost after send is refused, not signed as a contract without declarations', async () => {
    const { id, session } = await sentWithSession();
    await db('contracts').where({ id }).update({ rendered_content: null });

    const res = await sign(session, { name: 'Anna Muster', mode: 'typed', consents: undefined, accepted: true });
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

  test('a link re-issued after the candidates were read keeps the contract open', async () => {
    const { expireContract } = require('../../src/services/contract/expiry');
    const id = await newContract();
    await sendContract(id);
    const stale = await db('contracts').where({ id }).first();
    // The sweep read it as due (its link ran out); a resend since moved the deadline.
    const signingV2 = require('../../src/services/contract/signingV2');
    const signer = await db('contract_signers').where({ contract_id: id, role: 'customer' }).first();
    await signingV2.resendInvitation(id, signer.id, adminId);
    expect(await expireContract(stale, Date.now() + 24 * 60 * 60 * 1000)).toBe(false);
    expect((await db('contracts').where({ id }).first()).status).toBe('sent');
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

// ---------------------------------------------------------------------
// Slice 5 — versioned, hashed consents
// ---------------------------------------------------------------------

const ACCEPT = { key: 'acceptance', accepted: true };
const TERMS = { en: 'I accept the general terms.', de: 'Ich akzeptiere die AGB.' };
const IMAGES = { en: 'You may show photos of me on your website.', de: 'Sie dürfen Fotos von mir auf Ihrer Website zeigen.' };

/** A published template with its own declarations; returns its ids. */
async function templateWithConsents(list) {
  const [block] = await db('contract_blocks').where({ is_active: true }).orderBy('id').limit(1);
  const tplUrl = '/api/admin/contract-templates';
  const created = await ok(request(templatesApp).post(tplUrl).set(auth).send({ name: `Consents ${Date.now()}-${Math.random()}` }));
  const saved = await ok(request(templatesApp).put(`${tplUrl}/${created.template.id}/draft`).set(auth).send({
    lockVersion: created.template.lockVersion,
    items: [{ kind: 'block', blockId: block.id }],
    consents: list,
  }));
  const published = await ok(request(templatesApp).post(`${tplUrl}/${created.template.id}/publish`).set(auth)
    .send({ lockVersion: saved.template.lockVersion }));
  return { templateId: created.template.id, versionId: published.published.id, published };
}

const withTerms = [
  { key: 'acceptance', required: true, text: { en: 'I agree to be bound.', de: 'Ich bin einverstanden.' } },
  { key: 'terms', required: true, text: TERMS },
  { key: 'image_rights', required: false, text: IMAGES },
];

describe('consents', () => {
  test('a template\'s declarations are versioned by their wording and part of its hash', async () => {
    const tplUrl = '/api/admin/contract-templates';
    const { templateId, published } = await templateWithConsents(withTerms);
    expect(published.published.consents.map((c) => [c.key, c.required, c.version])).toEqual([
      ['acceptance', true, 1], ['terms', true, 1], ['image_rights', false, 1],
    ]);

    // Same wording keeps its version; changed wording or `required` counts up.
    const detail = await ok(request(templatesApp).get(`${tplUrl}/${templateId}`).set(auth));
    const saved = await ok(request(templatesApp).put(`${tplUrl}/${templateId}/draft`).set(auth).send({
      lockVersion: detail.template.lockVersion,
      consents: [
        withTerms[0],
        { key: 'terms', required: true, text: { ...TERMS, en: 'I accept the general terms of business.' } },
        { key: 'image_rights', required: true, text: IMAGES },
        { key: 'privacy', required: false, text: { en: 'Privacy notice read.' } },
      ],
    }));
    expect(saved.draft.consents.map((c) => [c.key, c.version])).toEqual([
      ['acceptance', 1], ['terms', 2], ['image_rights', 2], ['privacy', 1],
    ]);
    const republished = await ok(request(templatesApp).post(`${tplUrl}/${templateId}/publish`).set(auth)
      .send({ lockVersion: saved.template.lockVersion }));
    expect(republished.contentSha256).not.toBe(published.contentSha256);

    // A wording issued before gets its old number back (restoring an older
    // version does this); a new one goes past every number ever used.
    const current = await ok(request(templatesApp).get(`${tplUrl}/${templateId}`).set(auth));
    const reverted = await ok(request(templatesApp).put(`${tplUrl}/${templateId}/draft`).set(auth).send({
      lockVersion: current.template.lockVersion,
      consents: [withTerms[0], withTerms[1], { key: 'image_rights', required: true, text: IMAGES }],
    }));
    expect(reverted.draft.consents.map((c) => [c.key, c.version])).toEqual([['acceptance', 1], ['terms', 1], ['image_rights', 2]]);
    const third = await ok(request(templatesApp).put(`${tplUrl}/${templateId}/draft`).set(auth).send({
      lockVersion: reverted.template.lockVersion,
      consents: [withTerms[0], { key: 'terms', required: true, text: { ...TERMS, en: 'A third wording.' } }],
    }));
    expect(third.draft.consents.map((c) => [c.key, c.version])).toEqual([['acceptance', 1], ['terms', 3]]);

    // A key twice, or a template nobody has to confirm anything in, is refused.
    const again = await ok(request(templatesApp).get(`${tplUrl}/${templateId}`).set(auth));
    const twice = await request(templatesApp).put(`${tplUrl}/${templateId}/draft`).set(auth).send({
      lockVersion: again.template.lockVersion, consents: [withTerms[1], withTerms[1]],
    });
    expect(twice.status).toBe(400);
    const optionalOnly = await ok(request(templatesApp).put(`${tplUrl}/${templateId}/draft`).set(auth).send({
      lockVersion: again.template.lockVersion, consents: [withTerms[2]],
    }));
    const refused = await request(templatesApp).post(`${tplUrl}/${templateId}/publish`).set(auth)
      .send({ lockVersion: optionalOnly.template.lockVersion });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toMatch(/declaration/);
  });

  test('the migration gives a version without declarations today\'s wording, once', async () => {
    const version = await db('contract_template_versions').orderBy('id').first();
    await db('contract_template_versions').where({ id: version.id }).update({ consents: null });
    const migration = require('../../migrations/core/252_contract_consents');
    await migration.up(db);
    await migration.up(db);
    const row = await db('contract_template_versions').where({ id: version.id }).first();
    // Marked: this version's content hash predates the declarations.
    expect(row.consents_backfilled_at).toBeTruthy();
    const untouched = await db('contract_template_versions').whereNot({ id: version.id }).whereNotNull('consents_backfilled_at');
    expect(untouched).toHaveLength(0);
    const [entry] = parsed(row.consents);
    expect(entry).toEqual({
      key: 'acceptance', required: true, version: 1,
      text: {
        en: 'I have read this contract and agree to be bound by its terms.',
        de: 'Ich habe diesen Vertrag gelesen und erkläre mich mit seinen Bedingungen einverstanden.',
      },
    });
  });

  test('the send freezes the declarations into the hashed snapshot, and the signer answers each', async () => {
    const { versionId } = await templateWithConsents(withTerms);
    const { id, session } = await sentWithSession({ templateVersionId: versionId });
    const contract = await db('contracts').where({ id }).first();
    const snapshot = parsed(contract.rendered_content);
    expect(snapshot.consents.map((c) => c.key)).toEqual(['acceptance', 'terms', 'image_rights']);

    // Shown in the contract's language, and never pre-checked (nothing is).
    const view = await sessionView(session);
    expect(view.consents).toEqual([
      { key: 'acceptance', required: true, version: 1, text: 'Ich bin einverstanden.' },
      { key: 'terms', required: true, version: 1, text: TERMS.de },
      { key: 'image_rights', required: false, version: 1, text: IMAGES.de },
    ]);

    // A required one missing: refused, and nothing is written.
    const missing = await sign(session, { name: 'Anna Muster', mode: 'typed', consents: [ACCEPT] });
    expect(missing.status).toBe(400);
    expect(missing.body.code).toBe('CONSENT_REQUIRED');
    expect(missing.body.details.missingKeys).toEqual(['terms']);
    const unknown = await sign(session, { name: 'Anna Muster', mode: 'typed', consents: [ACCEPT, { key: 'terms', accepted: true }, { key: 'marketing', accepted: true }] });
    expect(unknown.status).toBe(400);
    expect(unknown.body.code).toBe('CONSENT_UNKNOWN');
    const signer = await db('contract_signers').where({ contract_id: id, role: 'customer' }).first();
    expect(signer.status).toBe('invited');
    expect(await db('contract_signer_consents').where({ signer_id: signer.id })).toHaveLength(0);
    expect(await eventTypes(id)).not.toContain('signed');

    // The optional one declined is recorded as declined.
    await ok(sign(session, { name: 'Anna Muster', mode: 'typed', consents: [ACCEPT, { key: 'terms', accepted: true }, { key: 'image_rights', accepted: false }] }));
    const rows = await db('contract_signer_consents').where({ signer_id: signer.id }).orderBy('id');
    const consentsService = require('../../src/services/contract/consents');
    expect(rows.map((r) => [r.consent_key, Number(r.version), !!r.accepted, r.text_sha256])).toEqual([
      ['acceptance', 1, true, consentsService.textSha256(snapshot.consents[0])],
      ['terms', 1, true, consentsService.textSha256({ text: TERMS })],
      ['image_rights', 1, false, consentsService.textSha256({ text: IMAGES })],
    ]);
    expect(rows[2].accepted_at).toBeNull();
    const signed = await db('contract_signing_events').where({ contract_id: id, event_type: 'signed' }).first();
    expect(parsed(signed.payload).consents.map((c) => [c.key, c.accepted])).toEqual([
      ['acceptance', true], ['terms', true], ['image_rights', false],
    ]);
    expect(parsed(signed.payload).consentVersion).toBe('v1');

    // The certificate carries one row per declaration.
    const certificate = require('../../src/services/pdf/signingCertificate');
    const spy = jest.spyOn(certificate, 'renderSigningCertificate');
    await ok(request(contractsApp).post(`/api/admin/contracts/${id}/countersign`).set(auth).send({ name: 'Studio Admin', mode: 'typed' }));
    const [{ signers }] = spy.mock.calls[0];
    spy.mockRestore();
    expect(signers[0].consents.map((c) => [c.key, c.accepted])).toEqual([
      ['acceptance', true], ['terms', true], ['image_rights', false],
    ]);
  });

  test('changing the template after send changes nothing the signer confirms', async () => {
    const tplUrl = '/api/admin/contract-templates';
    const { templateId, versionId } = await templateWithConsents(withTerms);
    const { id, session } = await sentWithSession({ templateVersionId: versionId });
    const before = await db('contracts').where({ id }).first();

    const detail = await ok(request(templatesApp).get(`${tplUrl}/${templateId}`).set(auth));
    const saved = await ok(request(templatesApp).put(`${tplUrl}/${templateId}/draft`).set(auth).send({
      lockVersion: detail.template.lockVersion,
      consents: [{ key: 'acceptance', required: true, text: { en: 'Different.', de: 'Anders.' } }],
    }));
    await ok(request(templatesApp).post(`${tplUrl}/${templateId}/publish`).set(auth).send({ lockVersion: saved.template.lockVersion }));

    const view = await sessionView(session);
    expect(view.consents.map((c) => c.text)).toEqual(['Ich bin einverstanden.', TERMS.de, IMAGES.de]);
    await ok(sign(session, { name: 'Anna Muster', mode: 'typed', consents: [ACCEPT, { key: 'terms', accepted: true }] }));
    const after = await db('contracts').where({ id }).first();
    expect(after.rendered_content_sha256).toBe(before.rendered_content_sha256);
  });

  test('a replayed signature with different declaration answers is not the one recorded', async () => {
    const { id, session } = await sentWithSession();
    const frozen = parsed((await db('contracts').where({ id }).first()).rendered_content).consents;
    const all = frozen.map((c) => ({ key: c.key, accepted: true }));
    await ok(sign(session, { name: 'Anna Muster', mode: 'typed', consents: all, idempotencyKey: 'consent-replay' }));
    expect((await ok(sign(session, { name: 'Anna Muster', mode: 'typed', consents: all, idempotencyKey: 'consent-replay' }))).replayed)
      .toBe(true);
    const changed = await sign(session, {
      name: 'Anna Muster', mode: 'typed', idempotencyKey: 'consent-replay',
      consents: [...all.map((c) => ({ ...c, accepted: false })), { key: 'made_up', accepted: true }],
    });
    expect(changed.status).toBe(409);
    expect(changed.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  test('an expired contract takes no paper copy', async () => {
    const id = await newContract();
    await sendContract(id);
    await db('contracts').where({ id }).update({ status: 'expired' });
    const upload = require('path').join(tmpDir, 'paper.pdf');
    fs.writeFileSync(upload, '%PDF-1.4');
    await expect(require('../../src/services/contract/signatures').attachSignedPdfUpload(id, upload, 'admin'))
      .rejects.toMatchObject({ statusCode: 409 });
    expect((await db('contracts').where({ id }).first()).status).toBe('expired');
  });

  test('a contract sent before declarations were frozen still signs with the single confirmation', async () => {
    const { canonicalSha256 } = require('../../src/utils/canonicalJson');
    const { id, session } = await sentWithSession();
    // What a snapshot from before this change looks like: no `consents`.
    const contract = await db('contracts').where({ id }).first();
    const snapshot = parsed(contract.rendered_content);
    delete snapshot.consents;
    await db('contracts').where({ id }).update({
      rendered_content: JSON.stringify(snapshot), rendered_content_sha256: canonicalSha256(snapshot),
    });

    expect((await sessionView(session)).consents).toBeNull();
    const unconfirmed = await sign(session, { name: 'Anna Muster', mode: 'typed', consents: undefined, accepted: false });
    expect(unconfirmed.status).toBe(400);
    expect(unconfirmed.body.code).toBe('TOS_REQUIRED');
    await ok(sign(session, { name: 'Anna Muster', mode: 'typed', consents: undefined, accepted: true }));
    const signer = await db('contract_signers').where({ contract_id: id, role: 'customer' }).first();
    expect(signer.status).toBe('signed');
    expect(signer.consent_version).toBe('v1');
    expect(await db('contract_signer_consents').where({ signer_id: signer.id })).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------
// Slice 6 — the signer's receipt and the admin's notice per signature
// ---------------------------------------------------------------------

describe('notices', () => {
  const adminNotices = () => db('email_queue').where({ email_type: 'contract_signed_admin_notification', recipient_email: 'studio@example.com' });

  test('each signer gets a receipt straight away, and the admin hears about every signature', async () => {
    const id = await newContract();
    await twoSigners(id);
    await sendContract(id);
    const before = (await adminNotices()).length;
    const ben = await verifiedSession(linkToken(await lastMail('contract_sent', 'ben@example.com')), 'ben@example.com');
    await ok(sign(ben, { name: 'Ben Muster', mode: 'typed' }));

    const receipt = await lastMail('contract_signature_received', 'ben@example.com');
    const contract = await db('contracts').where({ id }).first();
    expect(receipt).toEqual(expect.objectContaining({
      contract_number: contract.contract_number, customer_name: 'Ben Muster', issuer_name: 'Studio Test',
    }));
    expect(receipt.signed_at).toBeTruthy();
    expect(receipt.attachments).toBeUndefined();
    // Not everyone has signed, and the admin hears about it anyway.
    expect((await adminNotices()).length).toBe(before + 1);
  });

  test('with per-signature notices off, the admin hears only once everyone has signed', async () => {
    await setSetting('crm_contracts_notify_each_signature', false);
    try {
      const id = await newContract();
      await twoSigners(id);
      await sendContract(id);
      const before = (await adminNotices()).length;
      const ben = await verifiedSession(linkToken(await lastMail('contract_sent', 'ben@example.com')), 'ben@example.com');
      await ok(sign(ben, { name: 'Ben Muster', mode: 'typed' }));
      expect((await adminNotices()).length).toBe(before);
      const anna = await verifiedSession(linkToken(await lastMail('contract_sent', customerEmail)), customerEmail);
      await ok(sign(anna, { name: 'Anna Muster', mode: 'typed' }));
      expect((await adminNotices()).length).toBe(before + 1);
    } finally {
      await setSetting('crm_contracts_notify_each_signature', true);
    }
  });

  test('a receipt that fails to queue never fails the signature', async () => {
    const { id, session } = await sentWithSession();
    const emailProcessor = require('../../src/services/emailProcessor');
    const real = emailProcessor.queueEmail;
    const spy = jest.spyOn(emailProcessor, 'queueEmail').mockImplementation((...args) => (
      args[2] === 'contract_signature_received' ? Promise.reject(new Error('queue down')) : real(...args)
    ));
    try {
      await ok(sign(session, { name: 'Anna Muster', mode: 'typed' }));
    } finally {
      spy.mockRestore();
    }
    const contract = await db('contracts').where({ id }).first();
    expect(contract.status).toBe('signed_by_customer');
    expect(contract.follow_up_error).toMatch(/^signature_receipt:/);
  });
});

// ---------------------------------------------------------------------
// Slice 7 — reminders, workflow triggers, gated post-sign automation
// ---------------------------------------------------------------------

describe('reminders', () => {
  const reminders = (to) => db('email_queue').where({ email_type: 'contract_signature_reminder', recipient_email: to });
  // Time passing: the last link and the last reminder both lie `days` back.
  const backdateInvite = async (signerId, days) => {
    await db('contract_signers').where({ id: signerId }).update({ invited_at: daysAgo(days) });
    await db('contract_signers').where({ id: signerId }).whereNotNull('reminded_at').update({ reminded_at: daysAgo(days) });
  };

  test('a replica reading between another\'s claim and its new link does not send the next step', async () => {
    const { runContractSigningSweep } = require('../../src/services/contract/expiry');
    const id = await newContract();
    await sendContract(id);
    const signer = await db('contract_signers').where({ contract_id: id, role: 'customer' }).first();
    // Step one claimed just now, its new link not written yet: the old link is eight days old.
    await db('contract_signers').where({ id: signer.id })
      .update({ invited_at: daysAgo(8), reminder_count: 1, reminded_at: new Date().toISOString() });
    await runContractSigningSweep();
    expect(await db('contract_signing_events').where({ contract_id: id, event_type: 'reminded' })).toHaveLength(0);
    await db('contracts').where({ id }).update({ status: 'cancelled' });
  });

  test('no reminder or retry goes out with contracts switched off, or to a deactivated customer', async () => {
    const { runContractSigningSweep } = require('../../src/services/contract/expiry');
    const id = await newContract();
    await sendContract(id);
    const signer = await db('contract_signers').where({ contract_id: id, role: 'customer' }).first();
    await backdateInvite(signer.id, 4);
    const before = (await reminders(customerEmail)).length;
    await setFlag('contracts', false);
    try {
      await runContractSigningSweep();
    } finally {
      await setFlag('contracts', true);
    }
    expect((await reminders(customerEmail)).length).toBe(before);

    // Erasure keeps a partly signed contract `sent` with its customer deactivated.
    await db('customer_accounts').where({ id: customerId }).update({ is_active: false });
    try {
      await runContractSigningSweep();
      const manual = await request(contractsApp).post(`/api/admin/contracts/${id}/signers/${signer.id}/remind`).set(auth);
      expect(manual.status).toBe(409);
    } finally {
      await db('customer_accounts').where({ id: customerId }).update({ is_active: true });
    }
    expect((await reminders(customerEmail)).length).toBe(before);
    expect(await db('contract_signing_events').where({ contract_id: id, event_type: 'reminded' })).toHaveLength(0);
    await db('contracts').where({ id }).update({ status: 'cancelled' });
  });

  test('each ladder step goes out once, however many replicas run, with a new link', async () => {
    const { runContractSigningSweep } = require('../../src/services/contract/expiry');
    const id = await newContract();
    await sendContract(id);
    const firstLink = linkToken(await lastMail('contract_sent', customerEmail));
    const signer = await db('contract_signers').where({ contract_id: id, role: 'customer' }).first();
    const before = (await reminders(customerEmail)).length;

    // Two days in: not yet.
    await backdateInvite(signer.id, 2);
    await runContractSigningSweep();
    expect(await db('contract_signing_events').where({ contract_id: id, event_type: 'reminded' })).toHaveLength(0);

    // Four days in: step one, once.
    await backdateInvite(signer.id, 4);
    await Promise.all([runContractSigningSweep(), runContractSigningSweep()]);
    let events = await db('contract_signing_events').where({ contract_id: id, event_type: 'reminded' }).orderBy('seq');
    expect(events.map((e) => parsed(e.payload).step)).toEqual([1]);
    expect(Number((await db('contract_signers').where({ id: signer.id }).first()).reminder_count)).toBe(1);
    expect((await reminders(customerEmail)).length).toBe(before + 1);
    // The earlier link no longer works; the reminder's does.
    expect((await asSigner(request(signingApp).get(`/api/public/contract-signing/invite/${firstLink}`))).status).toBe(410);
    const reminderLink = linkToken(await lastMail('contract_signature_reminder', customerEmail));
    await ok(asSigner(request(signingApp).get(`/api/public/contract-signing/invite/${reminderLink}`)));

    // Seven days after that reminder: step two. Then the ladder is done.
    await backdateInvite(signer.id, 8);
    await Promise.all([runContractSigningSweep(), runContractSigningSweep()]);
    await backdateInvite(signer.id, 40);
    await runContractSigningSweep();
    events = await db('contract_signing_events').where({ contract_id: id, event_type: 'reminded' }).orderBy('seq');
    expect(events.map((e) => parsed(e.payload).step)).toEqual([1, 2]);
    expect((await reminders(customerEmail)).length).toBe(before + 2);
    expect((await require('../../src/services/contract/signingEvents').verifyChain(id)).ok).toBe(true);
  });

  test('in signing order: the second signer is not reminded while the first is due', async () => {
    const { runContractSigningSweep } = require('../../src/services/contract/expiry');
    const id = await newContract();
    await twoSigners(id, 'sequential');
    await sendContract(id);
    const [first, second] = await db('contract_signers').where({ contract_id: id, role: 'customer' }).orderBy('position');
    // Even with an invitation on record, the second signer isn't due yet.
    await db('contract_signers').where({ id: second.id }).update({ status: 'invited', invited_at: daysAgo(10) });
    await backdateInvite(first.id, 4);
    await runContractSigningSweep();
    const events = await db('contract_signing_events').where({ contract_id: id, event_type: 'reminded' });
    expect(events.map((e) => Number(e.signer_id))).toEqual([first.id]);
  });

  test('nobody is reminded once the contract is declined or expired', async () => {
    const { runContractSigningSweep } = require('../../src/services/contract/expiry');
    const declinedId = await newContract();
    await sendContract(declinedId);
    const session = await verifiedSession(linkToken(await lastMail('contract_sent', customerEmail)), customerEmail);
    await ok(asSigner(request(signingApp).post('/api/public/contract-signing/session/decline')).set('X-Signing-Session', session).send({}));
    const signer = await db('contract_signers').where({ contract_id: declinedId, role: 'customer' }).first();
    await backdateInvite(signer.id, 5);
    await runContractSigningSweep();
    expect(await db('contract_signing_events').where({ contract_id: declinedId, event_type: 'reminded' })).toHaveLength(0);
  });

  test('the admin\'s "Send reminder" uses the same path, and is refused for a signer who signed', async () => {
    const { id, session } = await sentWithSession();
    const signer = await db('contract_signers').where({ contract_id: id, role: 'customer' }).first();
    const res = await ok(request(contractsApp).post(`/api/admin/contracts/${id}/signers/${signer.id}/remind`).set(auth));
    expect(res).toEqual({ reminded: true, step: 1 });
    const event = await db('contract_signing_events').where({ contract_id: id, event_type: 'reminded' }).first();
    expect(parsed(event.payload)).toEqual({ step: 1, manual: true });
    expect(event.actor_type).toBe('admin');
    // The reminder replaced the session's link too.
    expect((await asSigner(request(signingApp).get('/api/public/contract-signing/session')).set('X-Signing-Session', session)).status).toBe(401);

    const fresh = await verifiedSession(linkToken(await lastMail('contract_signature_reminder', customerEmail)), customerEmail);
    await ok(sign(fresh, { name: 'Anna Muster', mode: 'typed' }));
    const refused = await request(contractsApp).post(`/api/admin/contracts/${id}/signers/${signer.id}/remind`).set(auth);
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('SIGNER_NOT_DUE');
  });

  test('reminders can be switched off', async () => {
    const { reminderSteps } = require('../../src/services/contract/expiry');
    expect(await reminderSteps()).toEqual([3, 7]);
    await setSetting('crm_contracts_reminder_days', '');
    expect(await reminderSteps()).toEqual([]);
    await setSetting('crm_contracts_reminder_days', '10, 2,x,2');
    expect(await reminderSteps()).toEqual([2, 10]);
    await setSetting('crm_contracts_reminder_days', '3,7');
  });
});

describe('workflow triggers and the gated invoice step', () => {
  async function flowFor(triggerType) {
    const [row] = await db('workflows').insert({
      name: `on ${triggerType}`, enabled: true, version: 1, trigger_type: triggerType, trigger_config: '{}',
    }).returning('id');
    const workflowId = typeof row === 'object' ? row.id : row;
    await db('workflow_nodes').insert({ workflow_id: workflowId, version: 1, node_key: 't', type: 'trigger', config: '{}', pos_x: 0, pos_y: 0 });
    return workflowId;
  }
  const runsOf = (workflowId) => db('workflow_runs').where({ workflow_id: workflowId });

  test('signed_by_customer, declined and expired each start a flow once', async () => {
    await setFlag('workflows', true);
    try {
      const onSigned = await flowFor('contract.signed_by_customer');
      const onDeclined = await flowFor('contract.declined');
      const onExpired = await flowFor('contract.expired');

      const { id: signedId, session } = await sentWithSession();
      await ok(sign(session, { name: 'Anna Muster', mode: 'typed' }));
      const { emitContractEvent } = require('../../src/services/contract/helpers');
      await emitContractEvent(await db('contracts').where({ id: signedId }).first(), 'signed_by_customer');
      expect((await runsOf(onSigned)).map((r) => Number(r.entity_id))).toEqual([signedId]);

      const { id: declinedId, session: declineSession } = await sentWithSession();
      await ok(asSigner(request(signingApp).post('/api/public/contract-signing/session/decline')).set('X-Signing-Session', declineSession).send({}));
      expect((await runsOf(onDeclined)).map((r) => Number(r.entity_id))).toEqual([declinedId]);

      const expiredId = await newContract();
      await sendContract(expiredId);
      await db('contracts').where({ id: expiredId }).update({ valid_until: dateOnly(daysAgo(30)) });
      const { runContractSigningSweep } = require('../../src/services/contract/expiry');
      await Promise.all([runContractSigningSweep(), runContractSigningSweep()]);
      expect((await runsOf(onExpired)).map((r) => Number(r.entity_id))).toEqual([expiredId]);
    } finally {
      await db('workflows').whereIn('trigger_type', ['contract.signed_by_customer', 'contract.declined', 'contract.expired']).update({ enabled: false });
      await setFlag('workflows', false);
    }
  });

  test('prepare_contract_invoice refuses an unfinished contract, dry-runs without writing, and drafts on hold', async () => {
    const { registry } = require('../../src/services/workflows');
    const action = registry.getAction('prepare_contract_invoice');
    const ctxFor = (contractId, vars = {}) => ({ run: { entity_type: 'contract', entity_id: contractId, workflow_id: null }, vars, db, node: { config: {} } });

    const { id, session } = await sentWithSession();
    await ok(sign(session, { name: 'Anna Muster', mode: 'typed' }));
    await expect(action(ctxFor(id))).rejects.toMatchObject({ code: 'CONTRACT_NOT_FULLY_SIGNED' });
    expect((await db('contracts').where({ id }).first()).follow_up_error).toMatch(/^prepare_contract_invoice:/);
    expect(await db('invoices').where({ source_contract_id: id })).toHaveLength(0);

    await ok(request(contractsApp).post(`/api/admin/contracts/${id}/countersign`).set(auth).send({ name: 'Studio Admin', mode: 'typed' }));
    expect(await action(ctxFor(id, { __dryRun: true }))).toEqual({ dryRun: true, would: 'prepare_contract_invoice', contractId: id });
    expect(await db('invoices').where({ source_contract_id: id })).toHaveLength(0);

    // An earlier failed attempt, still on the contract.
    await require('../../src/services/contract/signingV2')
      .recordFollowUpFailure(id, 'prepare_contract_invoice', new Error('earlier attempt'));
    const first = await action(ctxFor(id));
    // It is no longer outstanding.
    expect((await db('contracts').where({ id }).first()).follow_up_failed_at).toBeNull();
    const invoices = await db('invoices').where({ source_contract_id: id });
    expect(invoices).toHaveLength(1);
    expect(first.invoice_prepared).toEqual([invoices[0].id]);
    expect(invoices[0].scheduled_send_at).toBeNull();
    // A re-run adopts it rather than drafting a second one.
    expect(await action(ctxFor(id))).toEqual({ already: true, invoiceIds: [invoices[0].id] });
    expect(await db('invoices').where({ source_contract_id: id })).toHaveLength(1);
  });

  test('prepare_contract_invoice links invoices a crashed run left unlinked, instead of failing on the converted quote', async () => {
    const { registry } = require('../../src/services/workflows');
    const action = registry.getAction('prepare_contract_invoice');
    const quoteService = require('../../src/services/quoteService');
    const contractService = require('../../src/services/contractService');
    const quoteId = await quoteService.createQuote({
      customerAccountId: customerId, currency: 'CHF', vatRate: 0,
      lineItems: [{ position: 1, quantity: 1, description: 'Shoot', unit_price_minor: 100000, discount_percent: 0, parent_position: null }],
    }, adminId);
    await quoteService.sendQuote(quoteId, adminId);
    await quoteService.adminAcceptQuote(quoteId, adminId);
    const { contractId: id } = await contractService.createFromQuote(quoteId, adminId);
    await sendContract(id);
    const session = await verifiedSession(linkToken(await lastMail('contract_sent', customerEmail)), customerEmail);
    await ok(sign(session, { name: 'Anna Muster', mode: 'typed' }));
    await ok(request(contractsApp).post(`/api/admin/contracts/${id}/countersign`).set(auth).send({ name: 'Studio Admin', mode: 'typed' }));

    const ctx = { run: { entity_type: 'contract', entity_id: id, workflow_id: null }, vars: {}, db, node: { config: {} } };
    await action(ctx);
    const made = await db('invoices').where({ source_contract_id: id });
    expect(made.length).toBeGreaterThan(0);
    // The run crashed between committing the invoices and linking them.
    await db('invoices').where({ source_contract_id: id }).update({ source_contract_id: null });
    const again = await action({ ...ctx, vars: {} });
    expect(again.invoice_prepared.sort()).toEqual(made.map((i) => i.id).sort());
    expect(await db('invoices').where({ source_quote_id: quoteId })).toHaveLength(made.length);
  });

  test('the built-in "contract completed" flow ships disabled, with the approval in front of the action', async () => {
    const seed = require('../../src/services/_workflowSeedBoot');
    seed._resetBootForTests();
    await seed.seedBuiltinWorkflowsAtBoot(db, { info: () => {}, warn: () => {} });
    const wf = await db('workflows').where({ builtin_key: 'contract_completed_invoice' }).first();
    expect(wf.trigger_type).toBe('contract.signed');
    expect(!!wf.enabled).toBe(false);
    const edges = await db('workflow_edges').where({ workflow_id: wf.id, version: wf.version });
    const nodes = await db('workflow_nodes').where({ workflow_id: wf.id, version: wf.version });
    const typeOf = (key) => nodes.find((n) => n.node_key === key).type;
    const intoAction = edges.find((e) => nodes.find((n) => n.node_key === e.to_node && parsed(n.config).action === 'prepare_contract_invoice'));
    expect(typeOf(intoAction.from_node)).toBe('gate');
    expect(intoAction.from_handle).toBe('confirm');
  });
});

// ---------------------------------------------------------------------
// Slice 8 — the integrity report
// ---------------------------------------------------------------------

describe('integrity report', () => {
  const PNG = `data:image/png;base64,${'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='}`;
  const report = async (id) => ok(request(contractsApp).get(`/api/admin/contracts/${id}/verify-integrity`).set(auth));
  const failing = async (id) => (await report(id)).checks.filter((c) => c.ok === false).map((c) => c.check).sort();

  function flipByte(file) {
    const bytes = fs.readFileSync(file);
    const original = Buffer.from(bytes);
    bytes[Math.floor(bytes.length / 2)] ^= 0xff;
    fs.writeFileSync(file, bytes);
    return () => fs.writeFileSync(file, original);
  }

  test('a contract completed before certificates were recorded is not reported as missing one', async () => {
    const id = await newContract();
    await sendContract(id);
    const sent = await db('contracts').where({ id }).first();
    // Completed the older way: no `completed` event, no recorded certificate.
    await db('contracts').where({ id }).update({
      status: 'fully_signed', signing_version: 1, signed_pdf_path: sent.pdf_path, signed_pdf_sha256: sent.pdf_sha256,
    });
    const result = await report(id);
    expect(result.checks.find((c) => c.check === 'certificate')).toEqual(expect.objectContaining({ ok: null, note: 'not_recorded' }));
    expect(result.checks.filter((c) => c.ok === false)).toEqual([]);
    expect(result.ok).toBe(true);
  });

  test('each artefact altered in turn fails exactly its own check', async () => {
    const attachments = require('../../src/services/contract/attachments');
    const terms = await libraryAttachment('Integrity terms');
    const id = await newContract();
    await db.transaction((trx) => attachments.writeContractAttachments(trx, id, [
      { attachmentId: terms.id, delivery: 'separate' },
    ]));
    await sendContract(id);
    const session = await verifiedSession(linkToken(await lastMail('contract_sent', customerEmail)), customerEmail);
    await ok(sign(session, { name: 'Anna Muster', mode: 'drawn', signatureDataUrl: PNG }));
    await ok(request(contractsApp).post(`/api/admin/contracts/${id}/countersign`).set(auth).send({ name: 'Studio Admin', mode: 'typed' }));

    const clean = await report(id);
    expect(clean.ok).toBe(true);
    expect(clean.checks.map((c) => c.check)).toEqual([
      'unsigned_pdf', 'signed_pdf', 'certificate', 'signature_image', 'content', 'attachment', 'manifest',
      'event_chain', 'completed_artifact',
    ]);
    const logged = await db('activity_logs').where({ activity_type: 'contract_integrity_verified' }).orderBy('id', 'desc').first();
    expect(parsed(logged.metadata)).toEqual({ contractId: id, ok: true, failed: [] });

    const contract = await db('contracts').where({ id }).first();
    const certificate = await db('generated_documents').where({ doc_type: 'contract', doc_id: id, kind: 'audit' }).first();
    const signer = await db('contract_signers').where({ contract_id: id, role: 'customer' }).first();
    const library = await db('document_attachments').where({ id: terms.id }).first();
    const files = [
      [contract.pdf_path, ['unsigned_pdf']],
      [contract.signed_pdf_path, ['completed_artifact', 'signed_pdf']],
      [certificate.path, ['certificate']],
      [signer.signature_path, ['signature_image']],
      [attachments.readStoredFile(library).absolute, ['attachment']],
    ];
    for (const [file, expected] of files) {
      const restore = flipByte(file);
      expect(await failing(id)).toEqual(expected);
      restore();
    }

    // The frozen content, in the database.
    const snapshot = parsed(contract.rendered_content);
    await db('contracts').where({ id }).update({ rendered_content: JSON.stringify({ ...snapshot, title: 'Other' }) });
    expect(await failing(id)).toEqual(['content']);
    await db('contracts').where({ id }).update({ rendered_content: contract.rendered_content });

    // The manifest recorded with the sent PDF.
    const unsigned = await db('generated_documents').where({ doc_type: 'contract', doc_id: id, kind: 'unsigned' }).first();
    const manifest = parsed(unsigned.manifest);
    manifest.attachments[0].pages += 1;
    await db('generated_documents').where({ id: unsigned.id }).update({ manifest: JSON.stringify(manifest) });
    expect(await failing(id)).toEqual(['manifest']);
    await db('generated_documents').where({ id: unsigned.id }).update({ manifest: unsigned.manifest });

    // One event of the log, and where the chain breaks.
    const event = await db('contract_signing_events').where({ contract_id: id, seq: 2 }).first();
    await db('contract_signing_events').where({ id: event.id }).update({ actor_label: 'someone else' });
    const broken = await report(id);
    expect(broken.checks.filter((c) => c.ok === false).map((c) => c.check)).toEqual(['event_chain']);
    expect(broken.checks.find((c) => c.check === 'event_chain').brokenAt).toBe(2);
    await db('contract_signing_events').where({ id: event.id }).update({ actor_label: event.actor_label });
    expect((await report(id)).ok).toBe(true);

    // Each artefact removed in turn — the file, or its record — fails
    // exactly its own check, never a skip.
    const moveAway = (file) => {
      fs.renameSync(file, `${file}.gone`);
      return () => fs.renameSync(`${file}.gone`, file);
    };
    for (const [file, expected] of files) {
      const restore = moveAway(file);
      expect(await failing(id)).toEqual(expected);
      restore();
    }
    await db('generated_documents').where({ id: certificate.id }).update({ kind: 'audit-hidden' });
    expect(await failing(id)).toEqual(['certificate']);
    await db('generated_documents').where({ id: certificate.id }).update({ kind: 'audit' });
    await db('contract_signers').where({ id: signer.id }).update({ signature_path: null });
    expect(await failing(id)).toEqual(['signature_image']);
    await db('contract_signers').where({ id: signer.id }).update({ signature_sha256: null });
    expect(await failing(id)).toEqual(['signature_image']);
    await db('contract_signers').where({ id: signer.id })
      .update({ signature_path: signer.signature_path, signature_sha256: signer.signature_sha256 });
    await db('contracts').where({ id }).update({ signed_pdf_path: null });
    expect(await failing(id)).toEqual(['completed_artifact', 'signed_pdf']);
    await db('contracts').where({ id }).update({ signed_pdf_path: contract.signed_pdf_path });
    // The unsigned PDF with both its columns cleared: the send in the log still requires it.
    await db('contracts').where({ id }).update({ pdf_path: null, pdf_sha256: null });
    expect(await failing(id)).toEqual(['unsigned_pdf']);
    await db('contracts').where({ id }).update({ pdf_path: contract.pdf_path, pdf_sha256: contract.pdf_sha256 });
    await db('contracts').where({ id }).update({ signed_pdf_path: contract.signed_pdf_path });
    const allEvents = await db('contract_signing_events').where({ contract_id: id }).orderBy('seq');
    await db('contract_signing_events').where({ contract_id: id, event_type: 'completed' }).del();
    expect(await failing(id)).toEqual(['completed_artifact', 'event_chain']);
    await db('contract_signing_events').where({ contract_id: id }).del();
    expect(await failing(id)).toEqual(['completed_artifact', 'event_chain']);
    await db('contract_signing_events').insert(allEvents.map(({ id: _id, ...row }) => row));
    expect((await report(id)).ok).toBe(true);

    // The same report as a PDF.
    const pdf = await request(contractsApp).get(`/api/admin/contracts/${id}/verify-integrity?format=pdf`).set(auth)
      .buffer(true).parse((res, cb) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.headers['content-disposition']).toMatch(/^attachment;/);
    expect(pdf.body.slice(0, 5).toString()).toBe('%PDF-');
    expect((await PDFDocument.load(pdf.body)).getPageCount()).toBe(1);
  });
});

// ---------------------------------------------------------------------
// Slice 10 — enumeration and replay signals
// ---------------------------------------------------------------------

describe('enumeration and replay signals', () => {
  const signals = () => require('../../src/services/contract/signingSignals');
  const fromIp = (req, ip) => req.set('X-Forwarded-For', ip);
  const unknownToken = () => require('crypto').randomBytes(32).toString('hex');

  beforeEach(async () => {
    await signals().flush();
    signals()._internal.forgetClientSetting();
    await db('contract_signing_signals').del();
    await db('contract_signing_alerts').del();
  });

  test('refusals are counted per kind, with nothing sensitive in the rows', async () => {
    const probe = unknownToken();
    for (let i = 0; i < 3; i += 1) {
      const res = await fromIp(request(signingApp).get(`/api/public/contract-signing/invite/${probe}`), '203.0.113.9');
      expect(res.status).toBe(404);
    }
    // Wrong codes, on a real link.
    const { id } = await sentWithSession();
    const link = linkToken(await lastMail('contract_sent', customerEmail));
    await minuteLater();
    await ok(asSigner(request(signingApp).post(`/api/public/contract-signing/invite/${link}/code`)));
    const { code } = await lastMail('contract_signing_code', customerEmail);
    const wrong = code === '000000' ? '111111' : '000000';
    await fromIp(request(signingApp).post(`/api/public/contract-signing/invite/${link}/verify`), '203.0.113.9').send({ code: wrong });
    // A session asking for a file that isn't its contract's.
    const session = await verifiedSession(link, customerEmail);
    await fromIp(request(signingApp).get('/api/public/contract-signing/session/attachments/999999'), '203.0.113.9')
      .set('X-Signing-Session', session);
    // Tick the rate limit: 30 views a minute per client.
    for (let i = 0; i < 31; i += 1) {
      await fromIp(request(signingApp).get(`/api/public/contract-signing/invite/${probe}`), '203.0.113.77');
    }
    await new Promise((resolve) => setImmediate(resolve));

    await signals().flush();
    const rows = await db('contract_signing_signals');
    const sum = (kind, where = () => true) => rows.filter((r) => r.kind === kind && where(r)).reduce((a, r) => a + Number(r.count), 0);
    expect(sum('unknown_token', (r) => r.ip_hash === signals()._internal.ipHash('203.0.113.9'))).toBe(3);
    expect(sum('otp_failure', (r) => Number(r.contract_id) === id)).toBe(1);
    expect(sum('cross_contract', (r) => Number(r.contract_id) === id)).toBe(1);
    expect(sum('rate_limited')).toBeGreaterThanOrEqual(1);
    const text = JSON.stringify(rows);
    for (const secret of ['203.0.113.9', '203.0.113.77', probe, link, session, code]) expect(text).not.toContain(secret);
    expect(rows.every((r) => r.ip_hash === null || /^[0-9a-f]{64}$/.test(r.ip_hash))).toBe(true);

    const summary = await signals().summary();
    expect(summary.byKind.unknown_token).toBeGreaterThanOrEqual(3);
  });

  test('a session token that matches nothing counts as unknown, an ended one as stale', async () => {
    const res = await fromIp(request(signingApp).get('/api/public/contract-signing/session'), '203.0.113.21')
      .set('X-Signing-Session', unknownToken());
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('SIGNING_SESSION_INVALID');
    const { session } = await sentWithSession();
    await db('contract_signing_sessions').update({ revoked_at: new Date().toISOString() });
    const ended = await fromIp(request(signingApp).get('/api/public/contract-signing/session'), '203.0.113.21')
      .set('X-Signing-Session', session);
    expect(ended.body.code).toBe('SIGNING_SESSION_INVALID');
    await new Promise((resolve) => setImmediate(resolve));
    await signals().flush();
    const rows = await db('contract_signing_signals').where({ ip_hash: signals()._internal.ipHash('203.0.113.21') });
    const byKind = Object.fromEntries(rows.map((r) => [r.kind, Number(r.count)]));
    expect(byKind).toEqual({ unknown_token: 1, stale_token: 1 });
  });

  test('a threshold alerts the admin once per kind per hour, however many replicas check', async () => {
    await setSetting('crm_contracts_alert_unknown_tokens_per_ip', 3);
    const mails = () => db('email_queue').where({ email_type: 'contract_signing_suspicious_admin_notification' });
    const before = (await mails()).length;
    try {
      for (let i = 0; i < 3; i += 1) {
        await fromIp(request(signingApp).get(`/api/public/contract-signing/invite/${unknownToken()}`), '203.0.113.50');
      }
      await new Promise((resolve) => setImmediate(resolve));
      await signals().flush();
      const [a, b] = await Promise.all([signals().checkThresholds(), signals().checkThresholds()]);
      expect([...a, ...b]).toEqual(['unknown_token']);
      // Another flush in the same hour, more of the same: still once.
      await fromIp(request(signingApp).get(`/api/public/contract-signing/invite/${unknownToken()}`), '203.0.113.50');
      await new Promise((resolve) => setImmediate(resolve));
      await signals().flush();
      expect(await signals().checkThresholds()).toEqual([]);

      expect(await db('contract_signing_alerts')).toHaveLength(1);
      expect((await mails()).length).toBe(before + 1);
      const entries = await db('activity_logs').where({ activity_type: 'contract_signing_suspicious' });
      expect(entries).toHaveLength(1);
      expect(parsed(entries[0].metadata)).toEqual(expect.objectContaining({ kind: 'unknown_token', count: 3, limit: 3 }));
      expect(JSON.stringify(entries[0])).not.toContain('203.0.113.50');
      expect((await signals().summary()).alerts).toEqual([expect.objectContaining({ kind: 'unknown_token' })]);
    } finally {
      await setSetting('crm_contracts_alert_unknown_tokens_per_ip', 20);
    }
  });

  test('counts flushed into the previous hour are still checked', async () => {
    const { hourOf } = signals()._internal;
    const lastHour = hourOf(Date.now() - 60 * 60 * 1000);
    await setSetting('crm_contracts_alert_otp_failures_per_contract', 2);
    try {
      const contractId = await newContract();
      await db('contract_signing_signals').insert({
        hour: lastHour, kind: 'otp_failure', contract_id: contractId, ip_hash: null, count: 5, created_at: new Date().toISOString(),
      });
      await signals().runSignalFlush();
      expect(await db('contract_signing_alerts').where({ hour: lastHour, kind: 'otp_failure' })).toHaveLength(1);
    } finally {
      await setSetting('crm_contracts_alert_otp_failures_per_contract', 10);
    }
  });

  test('with "store IP" off, the overall threshold still alerts', async () => {
    await setSetting('crm_contracts_store_ip', false);
    signals()._internal.forgetClientSetting();
    await setSetting('crm_contracts_alert_unknown_tokens_per_hour', 4);
    try {
      for (let i = 0; i < 4; i += 1) {
        await fromIp(request(signingApp).get(`/api/public/contract-signing/invite/${unknownToken()}`), `203.0.113.${100 + i}`);
      }
      await signals().flush();
      expect(await signals().checkThresholds()).toEqual(['unknown_token:global']);
      expect(await signals().checkThresholds()).toEqual([]);
      expect((await signals().summary()).mode).toBe('global');
    } finally {
      await setSetting('crm_contracts_store_ip', true);
      signals()._internal.forgetClientSetting();
      await setSetting('crm_contracts_alert_unknown_tokens_per_hour', 200);
    }
    expect((await signals().summary()).mode).toBe('per_client');
  });

  test('the in-memory counts are capped, and past the cap still count overall', async () => {
    const { MAX_KEYS } = signals();
    signals()._internal.reset();
    const at = Date.now();
    await Promise.all(Array.from({ length: MAX_KEYS + 50 }, (_, i) => signals().record('otp_failure', { contractId: i + 1, at })));
    expect(signals()._internal.pendingSize()).toBeLessThanOrEqual(MAX_KEYS + 1);
    await signals().flush();
    const total = await db('contract_signing_signals').where({ kind: 'otp_failure' }).sum({ n: 'count' }).first();
    expect(Number(total.n)).toBe(MAX_KEYS + 50);
    const overflow = await db('contract_signing_signals').where({ kind: 'otp_failure' }).whereNull('contract_id').first();
    expect(Number(overflow.count)).toBe(50);
  });

  test('a flood of refusals reads the "store IP" setting once, not once per signal', async () => {
    signals()._internal.reset();
    const helpers = require('../../src/services/contract/helpers');
    const spy = jest.spyOn(helpers, 'maybeStoreIp');
    try {
      await Promise.all(Array.from({ length: 100 }, () => signals().record('rate_limited', { clientKey: '203.0.113.99' })));
      expect(spy.mock.calls.length).toBeLessThanOrEqual(1);
    } finally {
      spy.mockRestore();
    }
  });

  test('a batch that keeps failing to store is dropped after three tries', async () => {
    signals()._internal.reset();
    await signals().record('stale_token', {});
    // The store refuses: the table is gone for the moment.
    await db.schema.renameTable('contract_signing_signals', 'contract_signing_signals_away');
    try {
      await expect(signals().flush()).rejects.toThrow();
      expect(signals()._internal.pendingSize()).toBe(1);
      await expect(signals().flush()).rejects.toThrow();
      await expect(signals().flush()).rejects.toThrow();
      expect(signals()._internal.pendingSize()).toBe(0);
    } finally {
      await db.schema.renameTable('contract_signing_signals_away', 'contract_signing_signals');
    }
  });

  test('with "store IP" off, no client is kept at all', async () => {
    await setSetting('crm_contracts_store_ip', false);
    signals()._internal.forgetClientSetting();
    try {
      await fromIp(request(signingApp).get(`/api/public/contract-signing/invite/${unknownToken()}`), '203.0.113.60');
      await new Promise((resolve) => setImmediate(resolve));
      await signals().flush();
      const rows = await db('contract_signing_signals').where({ kind: 'unknown_token' });
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.ip_hash === null)).toBe(true);
    } finally {
      await setSetting('crm_contracts_store_ip', true);
      signals()._internal.forgetClientSetting();
    }
  });
});

// ---------------------------------------------------------------------
// Slice 11 — collect the customer's details, then freeze
// ---------------------------------------------------------------------

describe('collect-then-freeze', () => {
  const ADDRESS = {
    address_line1: 'Seestrasse 12', postal_code: '8001', city: 'Zürich', country_code: 'ch', company_name: 'Muster AG',
  };
  const details = (session, values) => asSigner(request(signingApp).post('/api/public/contract-signing/session/details'))
    .set('X-Signing-Session', session).send({ values });

  async function requested({ order = 'parallel' } = {}) {
    await db('customer_accounts').where({ id: customerId })
      .update({ address_line1: null, address_line2: null, postal_code: null, city: null, country_code: null, company_name: null });
    const id = await newContract();
    await twoSigners(id, order);
    const { contract: draft } = await ok(request(contractsApp).get(`/api/admin/contracts/${id}`).set(auth));
    expect(draft.customerAddressMissing).toBe(true);
    const res = await ok(request(contractsApp).post(`/api/admin/contracts/${id}/send`).set(auth).send({ collectData: true }));
    expect(res).toEqual({ status: 'awaiting_data', invited: 1 });
    return id;
  }

  test('asking for details freezes nothing, invites only the customer, and shows no contract', async () => {
    const id = await requested();
    const contract = await db('contracts').where({ id }).first();
    expect(contract.status).toBe('awaiting_data');
    expect(contract.rendered_content).toBeNull();
    expect(contract.pdf_path).toBeNull();
    expect(await eventTypes(id)).toEqual(['data_requested', 'invited']);
    const rows = await db('contract_signers').where({ contract_id: id, role: 'customer' }).orderBy('position');
    expect(rows.map((r) => r.status)).toEqual(['invited', 'pending']);

    const mail = await lastMail('contract_data_request', customerEmail);
    expect(mail.title).toBe('');
    expect(mail.attachments).toBeUndefined();
    const link = linkToken(mail);
    const summary = await ok(asSigner(request(signingApp).get(`/api/public/contract-signing/invite/${link}`)));
    expect(summary.status).toBe('awaiting_data');
    const session = await verifiedSession(link, customerEmail);
    const view = await sessionView(session);
    expect(view).not.toHaveProperty('sections');
    expect(view).not.toHaveProperty('title');
    expect(view).not.toHaveProperty('introText');
    expect(view.dataRequest.fields).toEqual(expect.arrayContaining(['address_line1', 'postal_code', 'city', 'country_code']));
    expect(view.dataRequest.required).toEqual(['address_line1', 'postal_code', 'city', 'country_code']);
    expect((await asSigner(request(signingApp).get('/api/public/contract-signing/session/pdf')).set('X-Signing-Session', session)).status).toBe(409);
    expect((await sign(session, { name: 'Anna Muster', mode: 'typed' })).status).toBe(409);
  });

  test('no route of the portal or the signing session shows the unfrozen contract', async () => {
    await db('customer_accounts').where({ id: customerId }).update({ address_line1: null, address_line2: null, postal_code: null, city: null });
    const quoteService = require('../../src/services/quoteService');
    const contractService = require('../../src/services/contractService');
    const quoteId = await quoteService.createQuote({
      customerAccountId: customerId, currency: 'CHF', vatRate: 0, eventName: 'Hidden shoot',
      lineItems: [{ position: 1, quantity: 1, description: 'Hidden line', unit_price_minor: 987654, discount_percent: 0, parent_position: null }],
    }, adminId);
    await quoteService.sendQuote(quoteId, adminId);
    await quoteService.adminAcceptQuote(quoteId, adminId);
    const { contractId: id } = await contractService.createFromQuote(quoteId, adminId);
    await db('contracts').where({ id }).update({ title: 'SECRET-TITLE', intro_text: 'SECRET-INTRO' });
    const { contract: draft } = await ok(request(contractsApp).get(`/api/admin/contracts/${id}`).set(auth));
    // A stretch of clause text the page would show (no placeholders in it).
    const clauseText = draft.inclusions.map((i) => (i.included && i.block && i.block.bodyTextDe) || '')
      .map((body) => body.replace(/\*\*/g, '').slice(20, 60)).find((part) => part.length === 40 && !part.includes('{'));
    expect(clauseText).toBeTruthy();
    await ok(request(contractsApp).post(`/api/admin/contracts/${id}/send`).set(auth).send({ collectData: true }));
    const session = await verifiedSession(linkToken(await lastMail('contract_data_request', customerEmail)), customerEmail);

    const jwt = require('jsonwebtoken');
    const express = require('express');
    const portal = express();
    portal.use(express.json());
    portal.use(require('cookie-parser')());
    portal.use('/api/customer', require('../../src/routes/customer'));
    portal.use(require('../../src/middleware/errorHandler').errorHandler);
    const cookie = `customer_token=${jwt.sign({ type: 'customer', customerId, iat: Math.floor(Date.now() / 1000) - 5 },
      process.env.JWT_SECRET, { algorithm: 'HS256', issuer: 'picpeak-auth', expiresIn: '1h' })}`;
    const asCustomer = (req) => req.set('Cookie', cookie);
    const asSession = (req) => asSigner(req).set('X-Signing-Session', session);

    const responses = [
      await asCustomer(request(portal).get('/api/customer/contracts')),
      await asCustomer(request(portal).get(`/api/customer/contracts/${id}`)),
      await asCustomer(request(portal).get(`/api/customer/contracts/${id}/pdf`)),
      await asCustomer(request(portal).get(`/api/customer/contracts/${id}/certificate`)),
      await asCustomer(request(portal).post(`/api/customer/contracts/${id}/sign`).send({ name: 'Anna', accepted: true })),
      await asSession(request(signingApp).get('/api/public/contract-signing/session')),
      await asSession(request(signingApp).get('/api/public/contract-signing/session/pdf')),
      await asSession(request(signingApp).get('/api/public/contract-signing/session/attachments/1')),
      await asSession(request(signingApp).post('/api/public/contract-signing/session/sign')).send({ name: 'Anna', mode: 'typed', accepted: true }),
    ];
    const secrets = ['SECRET-TITLE', 'SECRET-INTRO', 'Hidden line', '987654', '9876.54', '9’876.54', '%PDF'];
    secrets.push(clauseText);
    for (const res of responses) {
      const text = `${res.text || ''}${Buffer.isBuffer(res.body) ? res.body.toString('latin1') : ''}`;
      for (const secret of secrets) expect(text).not.toContain(secret);
    }
    // The single contract routes refuse outright.
    expect(responses.slice(1, 4).map((r) => r.status)).toEqual([409, 409, 409]);
    expect(responses[1].body.code).toBe('CONTRACT_NOT_READY');
    const listed = responses[0].body.contracts.find((c) => c.id === id);
    expect(listed).toEqual(expect.objectContaining({ status: 'awaiting_data', title: null, hasPdf: false, canCompleteDetails: true }));

    // Expired while it waited: still never frozen, still nothing to show.
    await db('contracts').where({ id }).update({ status: 'expired' });
    const after = [
      await asCustomer(request(portal).get('/api/customer/contracts')),
      await asCustomer(request(portal).get(`/api/customer/contracts/${id}`)),
      await asCustomer(request(portal).get(`/api/customer/contracts/${id}/pdf`)),
      await asCustomer(request(portal).get(`/api/customer/contracts/${id}/certificate`)),
    ];
    for (const res of after) {
      const text = `${res.text || ''}${Buffer.isBuffer(res.body) ? res.body.toString('latin1') : ''}`;
      for (const secret of secrets) expect(text).not.toContain(secret);
    }
    expect(after.slice(1).map((r) => r.status)).toEqual([404, 404, 404]);
    expect(after[0].body.contracts.find((c) => c.id === id)).toEqual(expect.objectContaining({ status: 'expired', title: null }));
  });

  test('the co-signer has no way in while details are collected', async () => {
    const id = await requested();
    const second = (await db('contract_signers').where({ contract_id: id, position: 2 }).first());
    expect(await db('contract_signer_invitations').where({ signer_id: second.id })).toHaveLength(0);
    // The admin can't hand them a link yet either.
    const resend = await request(contractsApp).post(`/api/admin/contracts/${id}/signers/${second.id}/resend`).set(auth);
    expect(resend.status).toBe(409);
    // And a session for them — however it came about — shows nothing.
    const { token: forced } = await require('../../src/services/contract/signers').createSession(second.id, 'otp');
    const res = await asSigner(request(signingApp).get('/api/public/contract-signing/session')).set('X-Signing-Session', forced);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('DATA_REQUEST_SIGNER');
    expect(JSON.stringify(res.body)).not.toMatch(/sections|introText/);
  });

  test('the details go onto the customer, then the contract is frozen with them and the others invited', async () => {
    const id = await requested();
    const session = await verifiedSession(linkToken(await lastMail('contract_data_request', customerEmail)), customerEmail);

    const invalid = await details(session, { ...ADDRESS, country_code: 'Schweiz', city: '' });
    expect(invalid.status).toBe(400);
    expect(invalid.body.code).toBe('DETAILS_INVALID');
    expect(invalid.body.details.fields.sort()).toEqual(['city', 'country_code']);
    const unknown = await details(session, { ...ADDRESS, email: 'x@example.com' });
    expect(unknown.status).toBe(400);
    expect((await db('contracts').where({ id }).first()).data_collected_at).toBeNull();

    const done = await ok(details(session, ADDRESS));
    expect(done).toEqual({ status: 'sent', frozen: true });
    const contract = await db('contracts').where({ id }).first();
    expect(contract.status).toBe('sent');
    expect(parsed(contract.rendered_content).placeholders.customer_address).toBe('Seestrasse 12, 8001, Zürich');
    const customer = await db('customer_accounts').where({ id: customerId }).first();
    expect(customer).toEqual(expect.objectContaining({ address_line1: 'Seestrasse 12', country_code: 'CH', company_name: 'Muster AG' }));
    expect(await eventTypes(id)).toEqual([
      'data_requested', 'invited', 'code_sent', 'verified', 'data_collected', 'sent', 'invited',
    ]);
    const collected = await db('contract_signing_events').where({ contract_id: id, event_type: 'data_collected' }).first();
    expect(parsed(collected.payload)).toEqual({ fields: ['address_line1', 'city', 'company_name', 'country_code', 'postal_code'] });
    // The co-signer is invited now, with the contract.
    expect(await lastMail('contract_sent', 'ben@example.com')).toBeTruthy();
    // The change is in the accounting history, and no value anywhere in the logs.
    const history = await require('../../src/services/accountingHistory').listHistory('customer', customerId);
    expect(history.some((h) => h.source === 'contract.data_collection')).toBe(true);
    const logs = JSON.stringify([
      await db('activity_logs').where('activity_type', 'like', 'contract_%'),
      await db('contract_signing_events').where({ contract_id: id }),
    ]);
    expect(logs).not.toContain('Seestrasse');
    expect(logs).not.toContain('Muster AG');

    // The same session now reads the frozen contract, and it can be signed.
    const view = await sessionView(session);
    expect(view.status).toBe('sent');
    expect(view.sections.length).toBeGreaterThan(0);
    await ok(sign(session, { name: 'Anna Muster', mode: 'typed' }));
    expect((await require('../../src/services/contract/signingEvents').verifyChain(id)).ok).toBe(true);
  });

  test('a second submission is refused, even one racing the first', async () => {
    const id = await requested();
    const session = await verifiedSession(linkToken(await lastMail('contract_data_request', customerEmail)), customerEmail);
    const [a, b] = await Promise.all([details(session, ADDRESS), details(session, { ...ADDRESS, city: 'Bern' })]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);
    const again = await details(session, ADDRESS);
    expect(again.status).toBe(409);
    expect(await db('contract_signing_events').where({ contract_id: id, event_type: 'data_collected' })).toHaveLength(1);
  });

  test('a failed render keeps the details and the status, and the admin sends again', async () => {
    const id = await requested();
    const session = await verifiedSession(linkToken(await lastMail('contract_data_request', customerEmail)), customerEmail);
    const pdfService = require('../../src/services/pdfService');
    const spy = jest.spyOn(pdfService, 'renderContractWithSlots').mockRejectedValueOnce(new Error('renderer down'));
    const res = await ok(details(session, ADDRESS));
    spy.mockRestore();
    expect(res).toEqual({ status: 'awaiting_data', frozen: false });
    const stuck = await db('contracts').where({ id }).first();
    expect(stuck.status).toBe('awaiting_data');
    expect(stuck.data_collected_at).toBeTruthy();
    expect(stuck.follow_up_error).toMatch(/^data_freeze:/);
    expect((await db('customer_accounts').where({ id: customerId }).first()).city).toBe('Zürich');
    // The customer sees the details were taken, not the contract.
    expect((await sessionView(session)).dataRequest.submitted).toBe(true);

    // The admin corrects what the customer typed on the customer record,
    // then finishes the send: the contract is frozen with the correction.
    const customersApp = buildRouteApp('/api/admin/customers', require('../../src/routes/adminCustomers'));
    await ok(request(customersApp).put(`/api/admin/customers/${customerId}`).set(auth).send({ city: 'Winterthur' }));
    const mailsBefore = (await db('email_queue').where({ email_type: 'contract_sent', recipient_email: customerEmail })).length;
    await ok(request(contractsApp).post(`/api/admin/contracts/${id}/send`).set(auth));
    const sent = await db('contracts').where({ id }).first();
    expect(sent.status).toBe('sent');
    expect(sent.follow_up_failed_at).toBeNull();
    expect(parsed(sent.rendered_content).placeholders.customer_address).toContain('Winterthur');
    // The customer was told to wait for an email: it comes, with a link to the contract.
    expect((await db('email_queue').where({ email_type: 'contract_sent', recipient_email: customerEmail })).length)
      .toBe(mailsBefore + 1);
    const fresh = await verifiedSession(linkToken(await lastMail('contract_sent', customerEmail)), customerEmail);
    expect((await sessionView(fresh)).status).toBe('sent');
  });

  test('the admin finishing a failed freeze still mails the first signer when a co-signer\'s mail fails', async () => {
    const id = await requested();
    const session = await verifiedSession(linkToken(await lastMail('contract_data_request', customerEmail)), customerEmail);
    const pdfService = require('../../src/services/pdfService');
    const render = jest.spyOn(pdfService, 'renderContractWithSlots').mockRejectedValueOnce(new Error('renderer down'));
    await ok(details(session, ADDRESS));
    render.mockRestore();

    const mailsBefore = (await db('email_queue').where({ email_type: 'contract_sent', recipient_email: customerEmail })).length;
    const emailProcessor = require('../../src/services/emailProcessor');
    const real = emailProcessor.queueEmail;
    const spy = jest.spyOn(emailProcessor, 'queueEmail').mockImplementation((...args) => (
      args[1] === 'ben@example.com' ? Promise.reject(new Error('queue down')) : real(...args)
    ));
    try {
      await ok(request(contractsApp).post(`/api/admin/contracts/${id}/send`).set(auth));
    } finally {
      spy.mockRestore();
    }
    const contract = await db('contracts').where({ id }).first();
    expect(contract.status).toBe('sent');
    expect(contract.follow_up_error).toMatch(/^invitation:/);
    expect((await db('email_queue').where({ email_type: 'contract_sent', recipient_email: customerEmail })).length)
      .toBe(mailsBefore + 1);
  });

  test('a co-signer\'s invitation failing after the freeze committed is not a failed freeze', async () => {
    const id = await requested();
    const session = await verifiedSession(linkToken(await lastMail('contract_data_request', customerEmail)), customerEmail);
    const emailProcessor = require('../../src/services/emailProcessor');
    const real = emailProcessor.queueEmail;
    const spy = jest.spyOn(emailProcessor, 'queueEmail').mockImplementation((...args) => (
      args[1] === 'ben@example.com' ? Promise.reject(new Error('queue down')) : real(...args)
    ));
    let res;
    try {
      res = await ok(details(session, ADDRESS));
    } finally {
      spy.mockRestore();
    }
    expect(res).toEqual({ status: 'sent', frozen: true });
    const contract = await db('contracts').where({ id }).first();
    expect(contract.status).toBe('sent');
    expect(contract.follow_up_error).toMatch(/^invitation:/);
    expect((await sessionView(session)).status).toBe('sent');
  });

  test('only the account holder as first signer can be asked for details, and the clock runs', async () => {
    await db('customer_accounts').where({ id: customerId }).update({ address_line1: null, city: null, postal_code: null });
    const id = await newContract();
    await ok(request(contractsApp).put(`/api/admin/contracts/${id}/signers`).set(auth).send({
      order: 'parallel', signers: [{ name: 'Ben Muster', email: 'ben@example.com' }, { name: 'Anna Muster', email: customerEmail }],
    }));
    const refused = await request(contractsApp).post(`/api/admin/contracts/${id}/send`).set(auth).send({ collectData: true });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('DATA_REQUEST_SIGNER');
    expect((await db('contracts').where({ id }).first()).status).toBe('draft');

    const waiting = await requested();
    await db('contracts').where({ id: waiting }).update({ valid_until: dateOnly(daysAgo(20)) });
    await require('../../src/services/contract/expiry').runContractSigningSweep();
    expect((await db('contracts').where({ id: waiting }).first()).status).toBe('expired');
  });
});

// ---------------------------------------------------------------------
// Slice 12 — the legal notice, frozen with what is signed
// ---------------------------------------------------------------------

describe('legal notice', () => {
  test('the notice is frozen at send, shown to the signer and printed on the certificate', async () => {
    const { DEFAULT_LEGAL_NOTICE } = require('../../src/services/contract/legalNotice');
    await setSetting('crm_contracts_legal_notice', { en: 'Custom notice.', de: '' });
    try {
      const { id, session } = await sentWithSession();
      const contract = await db('contracts').where({ id }).first();
      const snapshot = parsed(contract.rendered_content);
      // An empty language falls back to the default; the hash covers it.
      expect(snapshot.legalNotice).toEqual({ en: 'Custom notice.', de: DEFAULT_LEGAL_NOTICE.de });
      expect((await sessionView(session)).legalNotice).toBe(DEFAULT_LEGAL_NOTICE.de);

      // Changing the setting afterwards changes nothing already sent.
      await setSetting('crm_contracts_legal_notice', { en: 'Later.', de: 'Später.' });
      expect((await sessionView(session)).legalNotice).toBe(DEFAULT_LEGAL_NOTICE.de);

      await ok(sign(session, { name: 'Anna Muster', mode: 'typed' }));
      const certificate = require('../../src/services/pdf/signingCertificate');
      const spy = jest.spyOn(certificate, 'renderSigningCertificate');
      await ok(request(contractsApp).post(`/api/admin/contracts/${id}/countersign`).set(auth).send({ name: 'Studio Admin', mode: 'typed' }));
      expect(spy.mock.calls[0][0].legalNotice).toBe(DEFAULT_LEGAL_NOTICE.de);
      spy.mockRestore();
      expect((await db('contracts').where({ id }).first()).rendered_content_sha256).toBe(contract.rendered_content_sha256);
    } finally {
      await setSetting('crm_contracts_legal_notice', null);
    }
  });
});

describe('reminders, second pass', () => {
  const reminded = (id) => db('contract_signing_events').where({ contract_id: id, event_type: 'reminded' });

  test('a signer on the page is not reminded out of their session', async () => {
    const { runContractSigningSweep } = require('../../src/services/contract/expiry');
    const { id, session } = await sentWithSession();
    await sessionView(session);
    const signer = await db('contract_signers').where({ contract_id: id, role: 'customer' }).first();
    await db('contract_signers').where({ id: signer.id }).update({ invited_at: daysAgo(4) });
    await runContractSigningSweep();
    expect(await reminded(id)).toHaveLength(0);
    await ok(sign(session, { name: 'Anna Muster', mode: 'typed' }));

    // An ended session that opened the contract hours ago still counts.
    const other = await sentWithSession();
    await sessionView(other.session);
    const otherSigner = await db('contract_signers').where({ contract_id: other.id, role: 'customer' }).first();
    await db('contract_signing_sessions').where({ signer_id: otherSigner.id }).update({ expires_at: daysAgo(0.1) });
    await db('contract_signers').where({ id: otherSigner.id }).update({ invited_at: daysAgo(4) });
    await runContractSigningSweep();
    expect(await reminded(other.id)).toHaveLength(0);
    // A day later it doesn't.
    await db('contract_signing_sessions').where({ signer_id: otherSigner.id }).update({ viewed_at: daysAgo(2) });
    await runContractSigningSweep();
    expect(await reminded(other.id)).toHaveLength(1);
  });

  test('a reminder whose mail fails leaves the signer invitable, and the next sweep invites them again', async () => {
    const { runContractSigningSweep } = require('../../src/services/contract/expiry');
    const id = await newContract();
    await sendContract(id);
    const signer = await db('contract_signers').where({ contract_id: id, role: 'customer' }).first();
    await db('contract_signers').where({ id: signer.id }).update({ invited_at: daysAgo(4) });
    const emailProcessor = require('../../src/services/emailProcessor');
    const real = emailProcessor.queueEmail;
    const spy = jest.spyOn(emailProcessor, 'queueEmail').mockImplementation((...args) => (
      args[2] === 'contract_signature_reminder' ? Promise.reject(new Error('queue down')) : real(...args)
    ));
    try {
      await runContractSigningSweep();
    } finally {
      spy.mockRestore();
    }
    let contract = await db('contracts').where({ id }).first();
    expect(contract.follow_up_error).toMatch(/^reminder:/);
    expect((await db('contract_signers').where({ id: signer.id }).first()).status).toBe('pending');

    const before = (await db('email_queue').where({ email_type: 'contract_sent', recipient_email: customerEmail })).length;
    await runContractSigningSweep();
    expect((await db('contract_signers').where({ id: signer.id }).first()).status).toBe('invited');
    expect((await db('email_queue').where({ email_type: 'contract_sent', recipient_email: customerEmail })).length).toBe(before + 1);
    contract = await db('contracts').where({ id }).first();
    expect(contract.follow_up_failed_at).toBeNull();
    // A live link again.
    await ok(asSigner(request(signingApp).get(`/api/public/contract-signing/invite/${linkToken(await lastMail('contract_sent', customerEmail))}`)));
  });

  test('two sweeps retrying the same pending signer send one invitation', async () => {
    const signingV2 = require('../../src/services/contract/signingV2');
    const id = await newContract();
    await sendContract(id);
    const signer = await db('contract_signers').where({ contract_id: id, role: 'customer' }).first();
    await require('../../src/services/contract/signers').undoInvitation(signer.id);
    const before = (await db('email_queue').where({ email_type: 'contract_sent', recipient_email: customerEmail })).length;
    const counts = await Promise.all([signingV2.inviteDue(id), signingV2.inviteDue(id)]);
    expect(counts.sort()).toEqual([0, 1]);
    expect((await db('email_queue').where({ email_type: 'contract_sent', recipient_email: customerEmail })).length).toBe(before + 1);
    // The one link mailed is the one that works.
    await ok(asSigner(request(signingApp).get(`/api/public/contract-signing/invite/${linkToken(await lastMail('contract_sent', customerEmail))}`)));
  });

  test('no invitation goes to a signer of an erased customer, however the sweep got there', async () => {
    const signingV2 = require('../../src/services/contract/signingV2');
    const id = await newContract();
    await sendContract(id);
    const signer = await db('contract_signers').where({ contract_id: id, role: 'customer' }).first();
    await require('../../src/services/contract/signers').undoInvitation(signer.id);
    const before = (await db('email_queue').where({ email_type: 'contract_sent', recipient_email: customerEmail })).length;
    await db('customer_accounts').where({ id: customerId }).update({ is_active: false });
    try {
      // The sweep selected the contract before the erasure committed.
      expect(await signingV2.inviteDue(id)).toBe(0);
    } finally {
      await db('customer_accounts').where({ id: customerId }).update({ is_active: true });
    }
    expect((await db('email_queue').where({ email_type: 'contract_sent', recipient_email: customerEmail })).length).toBe(before);
    expect((await db('contract_signers').where({ id: signer.id }).first()).status).toBe('pending');
    await db('contracts').where({ id }).update({ status: 'cancelled' });
  });

  test('a signer whose address can\'t be read keeps the failure on the contract through every sweep', async () => {
    const { runContractSigningSweep } = require('../../src/services/contract/expiry');
    const id = await newContract();
    await sendContract(id);
    const signer = await db('contract_signers').where({ contract_id: id, role: 'customer' }).first();
    await require('../../src/services/contract/signers').undoInvitation(signer.id);
    await db('contract_signers').where({ id: signer.id }).update({ email_enc: 'v1:deadbeef:AAAA.AAAA.AAAA' });
    await runContractSigningSweep();
    await runContractSigningSweep();
    const contract = await db('contracts').where({ id }).first();
    expect(contract.follow_up_error).toMatch(/^invitation:/);
    expect((await db('contract_signers').where({ id: signer.id }).first()).status).toBe('pending');
  });

  test('a contract frozen after its details came in starts its ladder at the freeze', async () => {
    const { runContractSigningSweep } = require('../../src/services/contract/expiry');
    await db('customer_accounts').where({ id: customerId }).update({ address_line1: null, address_line2: null, postal_code: null, city: null });
    const id = await newContract();
    await ok(request(contractsApp).post(`/api/admin/contracts/${id}/send`).set(auth).send({ collectData: true }));
    const signer = await db('contract_signers').where({ contract_id: id, role: 'customer' }).first();
    // A details reminder went out while the details were awaited.
    await db('contract_signers').where({ id: signer.id }).update({ invited_at: daysAgo(4) });
    await runContractSigningSweep();
    expect(Number((await db('contract_signers').where({ id: signer.id }).first()).reminder_count)).toBe(1);
    const session = await verifiedSession(linkToken(await lastMail('contract_data_request', customerEmail)), customerEmail);
    await ok(asSigner(request(signingApp).post('/api/public/contract-signing/session/details')).set('X-Signing-Session', session)
      .send({ values: { address_line1: 'Seestrasse 12', postal_code: '8001', city: 'Zürich', country_code: 'CH' } }));
    await db('contract_signing_sessions').where({ signer_id: signer.id }).update({ revoked_at: new Date().toISOString() });
    const frozen = await db('contract_signers').where({ id: signer.id }).first();
    expect(Number(frozen.reminder_count)).toBe(0);
    // The link is days old, the freeze is not: no signing reminder yet.
    await db('contract_signers').where({ id: signer.id }).update({ invited_at: daysAgo(4) });
    const before = (await reminded(id)).length;
    await runContractSigningSweep();
    expect(await reminded(id)).toHaveLength(before);
  });
});

test('a clean signature clears only its own follow-up marker', async () => {
  const signingV2 = require('../../src/services/contract/signingV2');
  const id = await newContract();
  await twoSigners(id);
  await sendContract(id);
  await signingV2.recordFollowUpFailure(id, 'reminder', new Error('smtp down'));
  const ben = await verifiedSession(linkToken(await lastMail('contract_sent', 'ben@example.com')), 'ben@example.com');
  await ok(sign(ben, { name: 'Ben Muster', mode: 'typed' }));
  expect((await db('contracts').where({ id }).first()).follow_up_error).toMatch(/^reminder:/);
  await signingV2.recordFollowUpFailure(id, 'signature_receipt', new Error('queue down'));
  const anna = await verifiedSession(linkToken(await lastMail('contract_sent', customerEmail)), customerEmail);
  await ok(sign(anna, { name: 'Anna Muster', mode: 'typed' }));
  expect((await db('contracts').where({ id }).first()).follow_up_failed_at).toBeNull();
});

test('cancelling is conditional: a status that changed in between is never overwritten', async () => {
  const id = await newContract();
  await sendContract(id);
  const head = (await db('contracts').where({ id }).first()).audit_chain_head;
  // The signature lands between the cancel's read and its write.
  let flipped = false;
  const onQuery = (q) => {
    if (flipped || !/select/i.test(q.sql) || !/contracts/.test(q.sql) || /contract_/.test(q.sql)) return;
    flipped = true;
    db('contracts').where({ id }).update({ status: 'signed_by_customer' }).then(() => {}, () => {});
  };
  db.on('query', onQuery);
  let res;
  try {
    res = await request(contractsApp).post(`/api/admin/contracts/${id}/cancel`).set(auth);
  } finally {
    db.removeListener('query', onQuery);
  }
  expect(res.status).toBe(409);
  expect(res.body.code).toBe('CONTRACT_NOT_CANCELLABLE');
  const after = await db('contracts').where({ id }).first();
  expect(after.status).toBe('signed_by_customer');
  expect(after.audit_chain_head).toBe(head);
  expect(await db('contract_signing_events').where({ contract_id: id, event_type: 'revoked' })).toHaveLength(0);

  // An expired contract can't be cancelled either.
  const expired = await newContract();
  await sendContract(expired);
  await db('contracts').where({ id: expired }).update({ status: 'expired' });
  const refused = await request(contractsApp).post(`/api/admin/contracts/${expired}/cancel`).set(auth);
  expect(refused.body.code).toBe('CONTRACT_NOT_CANCELLABLE');
  expect((await db('contracts').where({ id: expired }).first()).status).toBe('expired');
});

test('a declaration\'s wording must be text, per language', async () => {
  const tplUrl = '/api/admin/contract-templates';
  const created = await ok(request(templatesApp).post(tplUrl).set(auth).send({ name: `Typed ${Date.now()}` }));
  const bad = [
    { en: { nested: 'x' } },
    { en: '' },
    { de: 'x'.repeat(1001) },
    ['I agree'],
  ];
  for (const text of bad) {
    const res = await request(templatesApp).put(`${tplUrl}/${created.template.id}/draft`).set(auth)
      .send({ lockVersion: created.template.lockVersion, consents: [{ key: 'acceptance', required: true, text }] });
    expect(res.status).toBe(400);
  }
  const { sanitizeConsents } = require('../../src/services/contract/consents');
  expect(() => sanitizeConsents([{ key: 'a', required: true, text: { en: 5 } }])).toThrow(/text per language/);
});

test('an open session can\'t sign past the deadline before the sweep has run', async () => {
  const { id, session } = await sentWithSession();
  await db('contracts').where({ id }).update({ valid_until: dateOnly(daysAgo(20)) });
  const view = await asSigner(request(signingApp).get('/api/public/contract-signing/session')).set('X-Signing-Session', session);
  expect(view.status).toBe(410);
  expect(view.body.code).toBe('CONTRACT_EXPIRED');
  const res = await sign(session, { name: 'Anna Muster', mode: 'typed' });
  expect(res.status).toBe(410);
  expect((await db('contract_signers').where({ contract_id: id, role: 'customer' }).first()).status).toBe('invited');
});

test('the portal offers Sign only when it is the customer\'s turn and they haven\'t answered', async () => {
  const jwt = require('jsonwebtoken');
  const express = require('express');
  const portal = express();
  portal.use(express.json());
  portal.use(require('cookie-parser')());
  portal.use('/api/customer', require('../../src/routes/customer'));
  portal.use(require('../../src/middleware/errorHandler').errorHandler);
  const cookie = `customer_token=${jwt.sign({ type: 'customer', customerId, iat: Math.floor(Date.now() / 1000) - 5 },
    process.env.JWT_SECRET, { algorithm: 'HS256', issuer: 'picpeak-auth', expiresIn: '1h' })}`;
  const listed = async (id) => (await ok(request(portal).get('/api/customer/contracts').set('Cookie', cookie)))
    .contracts.find((c) => c.id === id);
  const detail = async (id) => ok(request(portal).get(`/api/customer/contracts/${id}`).set('Cookie', cookie));

  // Parallel: Anna may sign; once she has, the list says so instead.
  const parallel = await newContract();
  await twoSigners(parallel);
  await sendContract(parallel);
  expect(await listed(parallel)).toEqual(expect.objectContaining({ canSign: true, signerState: null }));
  const anna = await verifiedSession(linkToken(await lastMail('contract_sent', customerEmail)), customerEmail);
  await ok(sign(anna, { name: 'Anna Muster', mode: 'typed' }));
  expect(await listed(parallel)).toEqual(expect.objectContaining({
    status: 'sent', canSign: false, signerState: 'signed', signerProgress: { signed: 1, total: 2 },
  }));
  expect(await detail(parallel)).toEqual(expect.objectContaining({ canSign: false, signerState: 'signed' }));

  // Sequential with Anna second: not her turn while Ben hasn't signed.
  const sequential = await newContract();
  await ok(request(contractsApp).put(`/api/admin/contracts/${sequential}/signers`).set(auth).send({
    order: 'sequential', signers: [{ name: 'Ben Muster', email: 'ben@example.com' }, { name: 'Anna Muster', email: customerEmail }],
  }));
  await sendContract(sequential);
  expect(await listed(sequential)).toEqual(expect.objectContaining({ canSign: false, signerState: 'waiting', waitingFor: 'Ben Muster' }));
  expect((await detail(sequential)).canSign).toBe(false);
});
