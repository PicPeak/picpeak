/**
 * Signing contracts and answering quotes from the customer portal.
 *
 * The portal's contract and quote lists used to include the live action
 * token so the dashboard could link to the public page. That put a bearer
 * secret — usable with no login — into every portal response. The portal
 * now signs and answers through session-authenticated routes, and the token
 * stays on the server.
 *
 * Pins:
 *   - no action token (or anything shaped like one) in any list or detail
 *   - canSign / canRespond reflect whether the document can still be acted on
 *   - another customer's document and drafts are a 404
 *   - signing, uploading and answering work with only the session
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-portal-docs-test-'));
process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(tmpDir, 'db.sqlite');
process.env.STORAGE_PATH = path.join(tmpDir, 'storage');
fs.mkdirSync(process.env.STORAGE_PATH, { recursive: true });
process.env.JWT_SECRET = process.env.JWT_SECRET || 'crm-route-test-secret';

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const { bootCrmDb, seedMinimal, createPublicToken } = require('../integration/helpers/crmDb');

const TOKEN_SHAPE = /[a-f0-9]{64}/i;

describe('customer portal contracts and quotes', () => {
  let db;
  let cleanup;
  let app;
  let customerId;
  let otherCustomerId;
  let cookie;
  let signable;
  let signableToken;
  let unsignable;
  let draft;
  let othersContract;
  let quote;
  let quoteToken;
  let othersQuote;

  const nowIso = () => new Date().toISOString();
  const insertId = async (table, row) => {
    const inserted = await db(table).insert(row).returning('id');
    return inserted[0]?.id ?? inserted[0];
  };
  const contract = (owner, status, number) => insertId('contracts', {
    contract_number: number, customer_account_id: owner, title: `Contract ${number}`, status,
    language: 'de', issue_date: nowIso().slice(0, 10), created_at: nowIso(),
  });
  const quoteRow = (owner, status, number) => insertId('quotes', {
    quote_number: number, customer_account_id: owner, currency: 'CHF', status, language: 'de',
    issue_date: nowIso().slice(0, 10), net_amount_minor: 10000, vat_amount_minor: 0,
    total_amount_minor: 10000, created_at: nowIso(),
  });

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    ({ customerId } = await seedMinimal(db));
    otherCustomerId = await insertId('customer_accounts', {
      email: 'other@example.com', display_name: 'Other', password_hash: 'x', is_active: 1, created_at: nowIso(),
    });
    await db('customer_accounts').whereIn('id', [customerId, otherCustomerId])
      .update({ feature_contracts: true, feature_quotes: true });
    const flag = await db('feature_flags').where({ key: 'contracts' }).first();
    if (flag) await db('feature_flags').where({ key: 'contracts' }).update({ value: true });
    else await db('feature_flags').insert({ key: 'contracts', value: true });
    // The global quotes switch for the customer surface is seeded off.
    const quotesSwitch = await db('app_settings').where({ setting_key: 'customer_feature_quotes_enabled' }).first();
    if (quotesSwitch) {
      await db('app_settings').where({ setting_key: 'customer_feature_quotes_enabled' }).update({ setting_value: 'true' });
    } else {
      await db('app_settings').insert({
        setting_key: 'customer_feature_quotes_enabled', setting_value: 'true', setting_type: 'customer_surface',
      });
    }

    signable = await contract(customerId, 'sent', 'K-P-1');
    signableToken = await createPublicToken(db, 'contract_action_tokens', { contract_id: signable });
    unsignable = await contract(customerId, 'sent', 'K-P-2'); // sent, but no live token
    draft = await contract(customerId, 'draft', 'K-P-3');
    othersContract = await contract(otherCustomerId, 'sent', 'K-P-4');
    await createPublicToken(db, 'contract_action_tokens', { contract_id: othersContract });

    quote = await quoteRow(customerId, 'sent', 'Q-P-1');
    quoteToken = await createPublicToken(db, 'quote_action_tokens', { quote_id: quote });
    othersQuote = await quoteRow(otherCustomerId, 'sent', 'Q-P-2');
    await createPublicToken(db, 'quote_action_tokens', { quote_id: othersQuote });

    const session = jwt.sign(
      { type: 'customer', customerId, iat: Math.floor(Date.now() / 1000) - 5 },
      process.env.JWT_SECRET,
      { algorithm: 'HS256', issuer: 'picpeak-auth', expiresIn: '1h' },
    );
    cookie = `customer_token=${session}`;

    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/customer', require('../../src/routes/customer'));
    app.use(require('../../src/middleware/errorHandler').errorHandler);
  }, 120000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  const get = (url) => request(app).get(url).set('Cookie', cookie);
  const post = (url) => request(app).post(url).set('Cookie', cookie);

  it('serves the signing certificate to its own customer only (#1446)', async () => {
    // Until this route existed the certificate only ever reached anyone as an
    // email attachment, so a lost email was a lost evidence record.
    const certDir = path.join(process.env.STORAGE_PATH, 'business-docs', 'contract', String(new Date().getFullYear()));
    fs.mkdirSync(certDir, { recursive: true });
    const file = path.join(certDir, 'K-P-1_certificate.pdf');
    fs.writeFileSync(file, '%PDF-1.4\ncertificate bytes\n%%EOF\n');
    await db('generated_documents').insert({
      doc_type: 'contract', doc_id: signable, kind: 'audit', path: file,
      sha256: 'a'.repeat(64), bytes: fs.statSync(file).size, renderer_version: '2', generated_at: nowIso(),
    });

    // The list says which contracts have one, so the button is only offered
    // where it works.
    const list = await get('/api/customer/contracts');
    const byNumber = Object.fromEntries(list.body.contracts.map((c) => [c.contractNumber, c]));
    expect(byNumber['K-P-1'].hasCertificate).toBe(true);
    expect(byNumber['K-P-2'].hasCertificate).toBe(false);

    const mine = await get(`/api/customer/contracts/${signable}/certificate`);
    expect(mine.status).toBe(200);
    expect(mine.headers['content-type']).toMatch('application/pdf');
    expect(mine.headers['x-content-type-options']).toBe('nosniff');
    expect(mine.headers['content-disposition']).toMatch(/^attachment;/);
    expect(mine.body.toString()).toContain('certificate bytes');

    // A contract with no certificate says so — not a 500, not an empty PDF.
    const none = await get(`/api/customer/contracts/${unsignable}/certificate`);
    expect(none.status).toBe(404);
    expect(none.body.code).toBe('CERTIFICATE_MISSING');

    // Another customer's contract, and a draft, are a plain 404 either way.
    expect((await get(`/api/customer/contracts/${othersContract}/certificate`)).status).toBe(404);
    expect((await get(`/api/customer/contracts/${draft}/certificate`)).status).toBe(404);
  });

  it('lists contracts without any signing token, with canSign', async () => {
    const res = await get('/api/customer/contracts');

    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toMatch(TOKEN_SHAPE);
    const byNumber = Object.fromEntries(res.body.contracts.map((c) => [c.contractNumber, c]));
    expect(byNumber['K-P-1']).not.toHaveProperty('responseToken');
    expect(byNumber['K-P-1'].canSign).toBe(true);
    expect(byNumber['K-P-2'].canSign).toBe(false);
    expect(byNumber['K-P-3']).toBeUndefined();
  });

  it('lists quotes without any response token, with canRespond', async () => {
    const res = await get('/api/customer/quotes');

    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toMatch(TOKEN_SHAPE);
    const q = res.body.quotes.find((row) => row.quoteNumber === 'Q-P-1');
    expect(q).not.toHaveProperty('responseToken');
    expect(q.canRespond).toBe(true);
  });

  it('shows a contract the customer owns, without its token', async () => {
    const res = await get(`/api/customer/contracts/${signable}`);

    expect(res.status).toBe(200);
    expect(res.body.canSign).toBe(true);
    expect(res.body.contract.contractNumber).toBe('K-P-1');
    expect(JSON.stringify(res.body)).not.toMatch(TOKEN_SHAPE);
  });

  it('answers 404 for a document owned by another customer and for a draft', async () => {
    expect((await get(`/api/customer/contracts/${othersContract}`)).status).toBe(404);
    expect((await get(`/api/customer/contracts/${draft}`)).status).toBe(404);
    expect((await post(`/api/customer/contracts/${othersContract}/sign`).send({ name: 'X', accepted: true })).status).toBe(404);
    expect((await get(`/api/customer/quotes/${othersQuote}`)).status).toBe(404);
  });

  it('refuses portal signing access to another customer\'s v2 contract, even to a listed signer (#1446)', async () => {
    // Being named as a signer on someone else's contract is not owning it.
    // The portal path opens a signing session with no code at all, so the
    // ownership filter is the only thing standing in front of it.
    const fieldEncryption = require('../../src/utils/fieldEncryption');
    const me = await db('customer_accounts').where({ id: customerId }).first();
    const foreign = await contract(otherCustomerId, 'sent', 'K-P-9');
    await db('contracts').where({ id: foreign }).update({ signing_version: 2 });
    await db('contract_signers').insert({
      contract_id: foreign, position: 1, role: 'customer', slot_key: 'customer-1',
      name_enc: fieldEncryption.encrypt('Someone'),
      email_enc: fieldEncryption.encrypt(me.email),
      email_hash: fieldEncryption.hashEmail(me.email),
      status: 'invited', created_at: nowIso(), updated_at: nowIso(),
    });

    expect((await post(`/api/customer/contracts/${foreign}/signing-access`)).status).toBe(404);
    expect((await get(`/api/customer/contracts/${foreign}/pdf`)).status).toBe(404);
    // …and nothing was minted on the way out.
    expect(await db('contract_signing_sessions').where({ signer_id: null })).toHaveLength(0);
    const signer = await db('contract_signers').where({ contract_id: foreign }).first();
    expect(await db('contract_signing_sessions').where({ signer_id: signer.id })).toHaveLength(0);
  });

  it('refuses an upload for a contract that cannot be signed, before writing the file', async () => {
    const uploadDir = path.join(process.env.STORAGE_PATH, 'uploads/contracts/signed');
    const before = fs.existsSync(uploadDir) ? fs.readdirSync(uploadDir).length : 0;

    const res = await post(`/api/customer/contracts/${unsignable}/upload-signed-pdf`)
      .attach('file', Buffer.from('%PDF-1.4 signed'), 'signed.pdf');

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('NOT_SIGNABLE');
    const after = fs.existsSync(uploadDir) ? fs.readdirSync(uploadDir).length : 0;
    expect(after).toBe(before);
  });

  it('refuses a portal upload whose bytes are not a PDF, keeping the token and writing no file', async () => {
    const id = await contract(customerId, 'sent', 'K-P-5');
    const linkToken = await createPublicToken(db, 'contract_action_tokens', { contract_id: id });
    const uploadDir = path.join(process.env.STORAGE_PATH, 'uploads/contracts/signed');
    const before = fs.existsSync(uploadDir) ? fs.readdirSync(uploadDir).length : 0;

    const res = await post(`/api/customer/contracts/${id}/upload-signed-pdf`)
      .attach('file', Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), { filename: 'signed.pdf', contentType: 'application/pdf' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_PDF');
    expect((await db('contracts').where({ id }).first()).status).toBe('sent');
    expect((await db('contract_action_tokens').where({ token: linkToken }).first()).used_at).toBeNull();
    const after = fs.existsSync(uploadDir) ? fs.readdirSync(uploadDir).length : 0;
    expect(after).toBe(before);
  });

  it('signs with the session alone and spends the server-side token', async () => {
    const res = await post(`/api/customer/contracts/${signable}/sign`).send({ name: 'Test Customer', accepted: true });

    expect(res.status).toBe(200);
    expect((await db('contracts').where({ id: signable }).first()).status).toBe('signed_by_customer');
    expect((await db('contract_action_tokens').where({ token: signableToken }).first()).used_at).not.toBeNull();

    const again = await post(`/api/customer/contracts/${signable}/sign`).send({ name: 'Test Customer', accepted: true });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('NOT_SIGNABLE');
  });

  it('rejects an incomplete signature as a validation error', async () => {
    const res = await post(`/api/customer/contracts/${unsignable}/sign`).send({});

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('answers a quote with the session alone', async () => {
    const detail = await get(`/api/customer/quotes/${quote}`);
    expect(detail.status).toBe(200);
    expect(detail.body.canRespond).toBe(true);
    expect(JSON.stringify(detail.body)).not.toMatch(TOKEN_SHAPE);

    const res = await post(`/api/customer/quotes/${quote}/respond`).send({ action: 'accept' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('accepted');
    expect((await db('quote_action_tokens').where({ token: quoteToken }).first()).used_at).not.toBeNull();
  });

  it('accepts a quote that offers add-ons, with the admin\'s choice and the total shown', async () => {
    // The portal has no add-on picker, so accepting means "as it stands":
    // the quote's stored choice, confirmed against the total the page shows.
    const withAddOns = await quoteRow(customerId, 'sent', 'Q-P-3');
    await createPublicToken(db, 'quote_action_tokens', { quote_id: withAddOns });
    await db('quote_line_items').insert([
      {
        quote_id: withAddOns, position: 1, quantity: 1, description: 'Wedding day',
        unit_price_minor: 10000, line_total_minor: 10000, is_optional: false, selected: true,
      },
      {
        quote_id: withAddOns, position: 2, quantity: 1, description: 'Album',
        unit_price_minor: 3000, line_total_minor: 3000, is_optional: true, selected: false,
      },
    ]);

    const detail = await get(`/api/customer/quotes/${withAddOns}`);
    expect(detail.status).toBe(200);
    const shown = detail.body.quote.totalAmountMinor;

    // Without the total the server has nothing to check the choice against.
    const unconfirmed = await post(`/api/customer/quotes/${withAddOns}/respond`).send({ action: 'accept' });
    expect(unconfirmed.status).toBe(400);
    expect(unconfirmed.body.code).toBe('TOTAL_REQUIRED');

    const res = await post(`/api/customer/quotes/${withAddOns}/respond`)
      .send({ action: 'accept', expectedTotalMinor: shown });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('accepted');
    const stored = await db('quotes').where({ id: withAddOns }).first();
    expect(stored.status).toBe('accepted');
    expect(stored.selection_accepted_at).toBeTruthy();
    // The album stays unbooked: the portal accepted what it displayed.
    const album = await db('quote_line_items').where({ quote_id: withAddOns, position: 2 }).first();
    expect([false, 0, '0', null]).toContain(album.selected);
  });

  it('refuses a stored contract path outside the contract folders with 403, and renders live only when the file is missing', async () => {
    const contractService = require('../../src/services/contractService');
    const live = jest.spyOn(contractService, 'renderContractPdfBuffer').mockResolvedValue(Buffer.from('%PDF-LIVE'));
    const { buildRouteApp } = require('../integration/helpers/crmDb');
    const verification = require('../../src/services/publicDocumentVerificationService');
    const publicApp = buildRouteApp('/api/public/contracts', require('../../src/routes/publicContracts'));

    const id = await contract(customerId, 'sent', 'K-P-PATH');
    const token = await createPublicToken(db, 'contract_action_tokens', { contract_id: id });
    const grant = verification.issueGrant('contract', await db('contract_action_tokens').where({ token }).first(), token);
    const both = async () => [
      await get(`/api/customer/contracts/${id}/pdf`).buffer(true),
      await request(publicApp).get(`/api/public/contracts/${token}/pdf`).set('X-Document-Access', grant).buffer(true),
    ];

    const dir = path.join(process.env.STORAGE_PATH, 'business-docs', 'contract', '2026');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'K-P-PATH.pdf'), '%PDF-STORED');
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-outside-'));
    fs.writeFileSync(path.join(outside, 'secret.pdf'), 'secret');
    fs.symlinkSync(path.join(outside, 'secret.pdf'), path.join(dir, 'K-P-PATH-link.pdf'));
    const invoiceDir = path.join(process.env.STORAGE_PATH, 'business-docs', 'invoice', '2026');
    fs.mkdirSync(invoiceDir, { recursive: true });
    fs.writeFileSync(path.join(invoiceDir, 'I-1.pdf'), '%PDF-INVOICE');

    try {
      // The stored file is served.
      await db('contracts').where({ id }).update({ pdf_path: 'business-docs/contract/2026/K-P-PATH.pdf' });
      for (const res of await both()) {
        expect(res.status).toBe(200);
        expect(Buffer.from(res.body).toString()).toBe('%PDF-STORED');
      }

      // Tampering: outside the root, climbing out, a symlink out, another folder.
      for (const bad of ['/etc/passwd', '../../../../etc/passwd',
        'business-docs/contract/2026/K-P-PATH-link.pdf', 'business-docs/invoice/2026/I-1.pdf']) {
        await db('contracts').where({ id }).update({ pdf_path: bad });
        for (const res of await both()) {
          expect(res.status).toBe(403);
          expect(String(res.text || '')).not.toMatch(/root:|secret|INVOICE/);
        }
      }
      expect(live).not.toHaveBeenCalled();

      // Simply missing, relative or from another root: rendered live.
      for (const gone of ['business-docs/contract/2026/gone.pdf', '/app/storage/business-docs/contract/2026/gone.pdf']) {
        await db('contracts').where({ id }).update({ pdf_path: gone });
        for (const res of await both()) {
          expect(res.status).toBe(200);
          expect(Buffer.from(res.body).toString()).toBe('%PDF-LIVE');
        }
      }
    } finally {
      live.mockRestore();
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});
