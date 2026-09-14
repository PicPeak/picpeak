/**
 * The emailed-code step in front of the public contract and quote pages.
 *
 * The link in a document email used to be the only secret: GET returned the
 * customer's name, email address, the document text and the customer's IP,
 * and sign / upload / download / respond needed nothing else. A forwarded
 * email, a shared screen or a logged URL was enough to read the document and
 * to sign it in the customer's name.
 *
 * Pins:
 *   - without a grant the page gets the issuer and an email hint, nothing else
 *   - send code → confirm → grant → full view
 *   - wrong codes, the attempt limit, expiry, the resend throttle, missing
 *     address and a failing mail transport
 *   - a grant only works for its own link and document kind, and expires
 *   - every action refuses without a grant and writes nothing
 *   - the grant is not accepted as an admin, gallery or customer session
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-doc-verify-test-'));
process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(tmpDir, 'db.sqlite');
process.env.STORAGE_PATH = path.join(tmpDir, 'storage');
fs.mkdirSync(process.env.STORAGE_PATH, { recursive: true });
process.env.JWT_SECRET = process.env.JWT_SECRET || 'crm-route-test-secret';

const request = require('supertest');
const jwt = require('jsonwebtoken');
const { bootCrmDb, seedMinimal, createPublicToken, buildRouteApp } = require('../integration/helpers/crmDb');
const tokenGuards = require('../../src/utils/publicTokenGuards');

const CUSTOMER_IP = '198.51.100.23';

describe('public document verification', () => {
  let db;
  let cleanup;
  let contractsApp;
  let quotesApp;
  let verification;
  let customerId;
  let contractId;
  let quoteId;
  const sent = [];

  const tokenRowFor = (table, token) => db(table).where({ token }).first();
  const contractToken = () => createPublicToken(db, 'contract_action_tokens', { contract_id: contractId });
  const quoteToken = () => createPublicToken(db, 'quote_action_tokens', { quote_id: quoteId });
  const grantFor = async (kind, table, token) => verification.issueGrant(kind, await tokenRowFor(table, token), token);
  const codeRowCount = async () => Number((await db('public_document_verification_codes').count({ n: '*' }).first()).n);

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    ({ customerId } = await seedMinimal(db));
    await db('customer_accounts').where({ id: customerId }).update({ display_name: 'Maria Meier' });

    const contract = await db('contracts').insert({
      contract_number: 'K-VER-0001',
      customer_account_id: customerId,
      title: 'Hochzeit Meier',
      issue_date: new Date().toISOString().slice(0, 10),
      status: 'sent',
      language: 'de',
      signed_customer_ip: CUSTOMER_IP,
      created_at: new Date().toISOString(),
    }).returning('id');
    contractId = contract[0]?.id ?? contract[0];

    const quote = await db('quotes').insert({
      quote_number: 'Q-VER-0001',
      customer_account_id: customerId,
      currency: 'CHF',
      issue_date: new Date().toISOString().slice(0, 10),
      net_amount_minor: 480000,
      vat_amount_minor: 0,
      total_amount_minor: 480000,
      status: 'sent',
      language: 'en',
      created_at: new Date().toISOString(),
    }).returning('id');
    quoteId = quote[0]?.id ?? quote[0];

    verification = require('../../src/services/publicDocumentVerificationService');
    contractsApp = buildRouteApp('/api/public/contracts', require('../../src/routes/publicContracts'));
    quotesApp = buildRouteApp('/api/public/quotes', require('../../src/routes/publicQuotes'));
  }, 120000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  beforeEach(() => {
    tokenGuards._internal.badAttempts.clear();
    sent.length = 0;
    jest.restoreAllMocks();
    // The transport is stubbed; the test reads the code from the call.
    jest.spyOn(verification, 'sendCodeEmail').mockImplementation(async (mail) => { sent.push(mail); });
  });

  describe('contract link without a grant', () => {
    it('shows the issuer and an email hint, and nothing about the customer or the contract', async () => {
      const token = await contractToken();

      const res = await request(contractsApp).get(`/api/public/contracts/${token}`);

      expect(res.status).toBe(200);
      expect(Object.keys(res.body.contract).sort()).toEqual(['emailHint', 'issuer', 'language', 'verificationRequired']);
      expect(res.body.contract.verificationRequired).toBe(true);
      expect(res.body.contract.emailHint).toBe('c***@example.com');
      const body = JSON.stringify(res.body);
      for (const secret of ['customer@example.com', 'Maria Meier', 'K-VER-0001', 'Hochzeit', CUSTOMER_IP]) {
        expect(body).not.toContain(secret);
      }
    });

    it('refuses to sign and writes nothing', async () => {
      const token = await contractToken();

      const res = await request(contractsApp)
        .post(`/api/public/contracts/${token}/sign`)
        .send({ name: 'Maria Meier', accepted: true });

      expect(res.status).toBe(401);
      expect(res.body.code).toBe('VERIFICATION_REQUIRED');
      expect((await db('contracts').where({ id: contractId }).first()).status).toBe('sent');
      expect((await tokenRowFor('contract_action_tokens', token)).used_at).toBeNull();
    });

    it('refuses an upload before anything is written to disk', async () => {
      const token = await contractToken();
      const uploadDir = path.join(process.env.STORAGE_PATH, 'uploads/contracts/signed');
      const before = fs.existsSync(uploadDir) ? fs.readdirSync(uploadDir).length : 0;

      const res = await request(contractsApp)
        .post(`/api/public/contracts/${token}/upload-signed-pdf`)
        .attach('file', Buffer.from('%PDF-1.4 signed'), 'signed.pdf');

      expect(res.status).toBe(401);
      expect(res.body.code).toBe('VERIFICATION_REQUIRED');
      const after = fs.existsSync(uploadDir) ? fs.readdirSync(uploadDir).length : 0;
      expect(after).toBe(before);
      expect((await tokenRowFor('contract_action_tokens', token)).used_at).toBeNull();
    });

    it('refuses the PDF download', async () => {
      const token = await contractToken();

      const res = await request(contractsApp).get(`/api/public/contracts/${token}/pdf`);

      expect(res.status).toBe(401);
      expect(res.body.code).toBe('VERIFICATION_REQUIRED');
    });
  });

  describe('emailed code', () => {
    const send = (token) => request(contractsApp).post(`/api/public/contracts/${token}/verification`);
    const confirm = (token, code) => request(contractsApp)
      .post(`/api/public/contracts/${token}/verification/confirm`)
      .send({ code });
    const wrong = (code) => (code === '000000' ? '111111' : '000000');

    it('sends a code to the customer, and confirming it opens the full contract', async () => {
      const token = await contractToken();

      const sendRes = await send(token);
      expect(sendRes.status).toBe(202);
      expect(sendRes.body).toEqual({ sent: true, emailHint: 'c***@example.com', resendAfterSeconds: 60 });
      expect(sent).toHaveLength(1);
      expect(sent[0]).toEqual(expect.objectContaining({
        to: 'customer@example.com', kind: 'contract', documentNumber: 'K-VER-0001', language: 'de',
      }));
      expect(sent[0].code).toMatch(/^\d{6}$/);

      const confirmRes = await confirm(token, sent[0].code);
      expect(confirmRes.status).toBe(200);
      expect(confirmRes.body.expiresInSeconds).toBe(30 * 60);

      const view = await request(contractsApp)
        .get(`/api/public/contracts/${token}`)
        .set('X-Document-Access', confirmRes.body.grant);
      expect(view.status).toBe(200);
      expect(view.body.contract).toEqual(expect.objectContaining({
        verificationRequired: false, contractNumber: 'K-VER-0001', title: 'Hochzeit Meier',
      }));
      expect(view.body.contract.recipient.email).toBe('customer@example.com');
    });

    it('counts down the remaining attempts on a wrong code', async () => {
      const token = await contractToken();
      await send(token);

      const res = await confirm(token, wrong(sent[0].code));

      expect(res.status).toBe(400);
      expect(res.body).toEqual(expect.objectContaining({ code: 'VERIFICATION_CODE_INVALID', attemptsRemaining: 4 }));
    });

    it('burns the code after five wrong attempts, so the right one no longer works', async () => {
      const token = await contractToken();
      await send(token);
      const { code } = sent[0];

      for (let i = 0; i < 4; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        expect((await confirm(token, wrong(code))).status).toBe(400);
      }
      const fifth = await confirm(token, wrong(code));
      expect(fifth.status).toBe(429);
      expect(fifth.body.code).toBe('VERIFICATION_TOO_MANY_ATTEMPTS');

      const late = await confirm(token, code);
      expect(late.status).toBe(410);
      expect(late.body.code).toBe('VERIFICATION_CODE_EXPIRED');
    });
    it('refuses an expired code', async () => {
      const token = await contractToken();
      await send(token);
      const tokenRow = await tokenRowFor('contract_action_tokens', token);
      await db('public_document_verification_codes')
        .where({ document_kind: 'contract', action_token_id: tokenRow.id })
        .update({ expires_at: new Date(Date.now() - 1000).toISOString() });

      const res = await confirm(token, sent[0].code);

      expect(res.status).toBe(410);
      expect(res.body.code).toBe('VERIFICATION_CODE_EXPIRED');
    });

    it('rejects a malformed code as a validation error', async () => {
      const token = await contractToken();

      const res = await confirm(token, '12ab');

      expect(res.status).toBe(400);
    });

    it('throttles resends: once a minute and five times an hour per link', async () => {
      const token = await contractToken();
      expect((await send(token)).status).toBe(202);

      const again = await send(token);
      expect(again.status).toBe(429);
      expect(again.body.code).toBe('VERIFICATION_RATE_LIMITED');
      expect(again.body.retryAfterSeconds).toBeGreaterThan(0);

      const hourly = await contractToken();
      const hourlyRow = await tokenRowFor('contract_action_tokens', hourly);
      const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000).toISOString();
      await db('public_document_verification_codes').insert(Array.from({ length: 5 }, () => ({
        document_kind: 'contract',
        action_token_id: hourlyRow.id,
        code_hash: 'x',
        attempts: 0,
        expires_at: twoMinutesAgo,
        consumed_at: twoMinutesAgo,
        created_at: twoMinutesAgo,
      })));
      const capped = await send(hourly);
      expect(capped.status).toBe(429);
      expect(capped.body.code).toBe('VERIFICATION_RATE_LIMITED');
      expect(sent).toHaveLength(1);
    });

    it('answers 409 when the customer has no email address to send to', async () => {
      const insertedCustomer = await db('customer_accounts').insert({
        email: '', display_name: 'No Mail', password_hash: 'x', is_active: 1, created_at: new Date().toISOString(),
      }).returning('id');
      const otherCustomerId = insertedCustomer[0]?.id ?? insertedCustomer[0];
      const inserted = await db('contracts').insert({
        contract_number: 'K-VER-0002', customer_account_id: otherCustomerId, status: 'sent', language: 'en',
        issue_date: new Date().toISOString().slice(0, 10), created_at: new Date().toISOString(),
      }).returning('id');
      const token = await createPublicToken(db, 'contract_action_tokens', { contract_id: inserted[0]?.id ?? inserted[0] });

      const res = await send(token);

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('NO_RECIPIENT_EMAIL');
      expect(sent).toHaveLength(0);
    });

    it('answers 503 when the email cannot be sent, and leaves no live code behind', async () => {
      verification.sendCodeEmail.mockRejectedValueOnce(new Error('Email service not configured'));
      const token = await contractToken();
      const rowsBefore = await codeRowCount();

      const res = await send(token);

      expect(res.status).toBe(503);
      expect(res.body.code).toBe('EMAIL_UNAVAILABLE');
      expect(await codeRowCount()).toBe(rowsBefore);
    });
  });

  describe('grant scope', () => {
    it('only opens the link it was issued for', async () => {
      const tokenA = await contractToken();
      const tokenB = await contractToken();
      const grantA = await grantFor('contract', 'contract_action_tokens', tokenA);

      const view = await request(contractsApp).get(`/api/public/contracts/${tokenB}`).set('X-Document-Access', grantA);
      expect(view.body.contract.verificationRequired).toBe(true);

      const sign = await request(contractsApp)
        .post(`/api/public/contracts/${tokenB}/sign`)
        .set('X-Document-Access', grantA)
        .send({ name: 'Maria Meier', accepted: true });
      expect(sign.status).toBe(401);
    });

    it('does not carry over between document kinds', async () => {
      const token = await contractToken();
      const tokenRow = await tokenRowFor('contract_action_tokens', token);
      const quoteKindGrant = verification.issueGrant('quote', tokenRow, token);

      const res = await request(contractsApp)
        .get(`/api/public/contracts/${token}/pdf`)
        .set('X-Document-Access', quoteKindGrant);

      expect(res.status).toBe(401);
    });

    it('stops working once it expires', async () => {
      const token = await contractToken();
      const tokenRow = await tokenRowFor('contract_action_tokens', token);
      const expired = jwt.sign(
        {
          type: 'public_document', kind: 'contract', tokenId: tokenRow.id,
          th: verification.tokenFingerprint(token), exp: Math.floor(Date.now() / 1000) - 10,
        },
        process.env.JWT_SECRET,
        { algorithm: 'HS256', issuer: 'picpeak-auth' },
      );

      const res = await request(contractsApp)
        .post(`/api/public/contracts/${token}/sign`)
        .set('X-Document-Access', expired)
        .send({ name: 'Maria Meier', accepted: true });

      expect(res.status).toBe(401);
      expect((await db('contracts').where({ id: contractId }).first()).status).toBe('sent');
    });

    it('is not accepted as an admin, gallery or customer session', async () => {
      const token = await contractToken();
      const grant = await grantFor('contract', 'contract_action_tokens', token);
      const res = () => {
        const out = { statusCode: null };
        out.status = (code) => { out.statusCode = code; return out; };
        out.json = () => out;
        return out;
      };

      const { adminAuth } = require('../../src/middleware/auth');
      const adminRes = res();
      const adminNext = jest.fn();
      await adminAuth({ headers: { authorization: `Bearer ${grant}` }, cookies: {}, originalUrl: '/api/admin/events', ip: '127.0.0.1' }, adminRes, adminNext);
      expect(adminNext).not.toHaveBeenCalled();
      expect(adminRes.statusCode).toBeGreaterThanOrEqual(401);

      const { verifyGalleryAccess } = require('../../src/middleware/gallery');
      const galleryRes = res();
      const galleryNext = jest.fn();
      await verifyGalleryAccess({
        params: { slug: 'any-gallery' }, query: {}, headers: { authorization: `Bearer ${grant}` }, cookies: {}, ip: '127.0.0.1',
      }, galleryRes, galleryNext);
      expect(galleryNext).not.toHaveBeenCalled();
      expect(galleryRes.statusCode).toBeGreaterThanOrEqual(401);

      const { customerAuth } = require('../../src/middleware/customerAuth');
      const customerRes = res();
      const customerNext = jest.fn();
      await customerAuth({ headers: {}, cookies: { customer_token: grant }, originalUrl: '/api/customer/contracts', ip: '127.0.0.1' }, customerRes, customerNext);
      expect(customerNext).not.toHaveBeenCalled();
      expect(customerRes.statusCode).toBeGreaterThanOrEqual(401);
    });
  });

  describe('quote link', () => {
    it('shows nothing about the quote or the customer without a grant', async () => {
      const token = await quoteToken();

      const res = await request(quotesApp).get(`/api/public/quotes/${token}`);

      expect(res.status).toBe(200);
      expect(Object.keys(res.body.quote).sort()).toEqual(['emailHint', 'issuer', 'language', 'verificationRequired']);
      const body = JSON.stringify(res.body);
      for (const secret of ['customer@example.com', 'Maria Meier', 'Q-VER-0001', '480000']) {
        expect(body).not.toContain(secret);
      }
    });

    it('refuses to record an answer without a grant', async () => {
      const token = await quoteToken();

      const res = await request(quotesApp).post(`/api/public/quotes/${token}/respond`).send({ action: 'accept' });

      expect(res.status).toBe(401);
      expect(res.body.code).toBe('VERIFICATION_REQUIRED');
      expect((await db('quotes').where({ id: quoteId }).first()).status).toBe('sent');
    });

    it('sends the code in the quote language and records the answer once confirmed', async () => {
      const token = await quoteToken();

      expect((await request(quotesApp).post(`/api/public/quotes/${token}/verification`)).status).toBe(202);
      expect(sent[0]).toEqual(expect.objectContaining({ kind: 'quote', documentNumber: 'Q-VER-0001', language: 'en' }));
      const confirmRes = await request(quotesApp)
        .post(`/api/public/quotes/${token}/verification/confirm`)
        .send({ code: sent[0].code });
      expect(confirmRes.status).toBe(200);

      const res = await request(quotesApp)
        .post(`/api/public/quotes/${token}/respond`)
        .set('X-Document-Access', confirmRes.body.grant)
        .send({ action: 'accept' });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('accepted');
    });
  });
});
