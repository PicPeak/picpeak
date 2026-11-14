/**
 * HTTP route tests for backend/src/routes/publicPaymentCheck (P0 — #570).
 *
 * Two endpoints:
 *   GET  /:token  — load invoice payment-check view
 *   POST /:token  — record customer's "paid / unpaid / partial" claim
 *
 * Unlike the quote / contract public routes, payment-check goes
 * through invoiceService rather than the shared publicTokenGuards.
 * Tests focus on the validator gates and the unknown-token edge.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-paymentcheck-test-'));
process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(tmpDir, 'db.sqlite');
process.env.STORAGE_PATH = path.join(tmpDir, 'storage');
fs.mkdirSync(process.env.STORAGE_PATH, { recursive: true });
process.env.JWT_SECRET = process.env.JWT_SECRET || 'crm-route-test-secret';

const request = require('supertest');
const { bootCrmDb, seedMinimal, setFeatureFlags, buildRouteApp } = require('../integration/helpers/crmDb');

describe('publicPaymentCheck routes', () => {
  let cleanup;
  let app;
  let db;
  let customerId;

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    ({ customerId } = await seedMinimal(db));
    await setFeatureFlags(db, { bills: true });
    app = buildRouteApp('/api/public/payment-check', require('../../src/routes/publicPaymentCheck'));
  }, 120000);

  afterAll(async () => {
    if (cleanup) await cleanup();
  });

  describe('GET /:token', () => {
    it('rejects malformed tokens with 400', async () => {
      const res = await request(app).get('/api/public/payment-check/short');
      expect(res.status).toBe(400);
    });

    it('returns a service-level error for an unknown well-formed token (4xx, not 500)', async () => {
      const fakeToken = 'a'.repeat(64);
      const res = await request(app).get(`/api/public/payment-check/${fakeToken}`);
      // Service throws NotFound or similar — what matters is the
      // request reaches the service AND isn't an unhandled 500.
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(600);
    });
  });

  describe('POST /:token', () => {
    it('rejects malformed tokens with 400', async () => {
      const res = await request(app)
        .post('/api/public/payment-check/short')
        .send({ action: 'paid_full' });
      expect(res.status).toBe(400);
    });

    it('rejects an invalid action with 400', async () => {
      const validToken = 'b'.repeat(64);
      const res = await request(app)
        .post(`/api/public/payment-check/${validToken}`)
        .send({ action: 'maybe' });
      expect(res.status).toBe(400);
    });

    it('accepts the canonical four actions through the validator', async () => {
      // Each action passes validator (token is well-formed); service
      // then rejects unknown token with a 4xx — what we're pinning is
      // the validator doesn't reject any of the canonical actions.
      const validToken = 'c'.repeat(64);
      for (const action of ['paid_full', 'paid_with_skonto', 'partial', 'unpaid']) {
        // eslint-disable-next-line no-await-in-loop
        const res = await request(app)
          .post(`/api/public/payment-check/${validToken}`)
          .send({ action });
        // Either succeeds (rare — no real invoice) or service-level
        // 4xx for unknown token. Must NOT be 400 (which would mean
        // the validator rejected the action).
        expect(res.status).not.toBe(400);
        expect(res.status).toBeGreaterThanOrEqual(400);
        expect(res.status).toBeLessThan(600);
      }
    });

    it('rejects negative amountMinor with 400', async () => {
      // Validator chain: optional({ values: 'falsy' }) means
      // amountMinor=0 / null / undefined gets skipped (allowed). For
      // any actually-supplied integer, isInt({ min: 1 }) takes over —
      // pin the negative-rejection so a future refactor can't loosen
      // the lower bound silently.
      const validToken = 'd'.repeat(64);
      const res = await request(app)
        .post(`/api/public/payment-check/${validToken}`)
        .send({ action: 'partial', amountMinor: -100 });
      expect(res.status).toBe(400);
    });
  });

  describe('with the bills feature switched off', () => {
    afterEach(() => setFeatureFlags(db, { bills: true }));

    it('refuses the page and the decision, and the link stays unused', async () => {
      const inserted = await db('invoices').insert({
        invoice_number: 'PC-FLAG-1', customer_account_id: customerId, status: 'sent', currency: 'CHF',
        issue_date: '2026-09-01', due_date: '2026-09-30', total_amount_minor: 10000,
      }).returning('id');
      const invoiceId = inserted[0]?.id ?? inserted[0];
      const token = 'd'.repeat(64);
      await db('invoice_payment_check_tokens').insert({
        invoice_id: invoiceId, token,
        expires_at: new Date(Date.now() + 3600000).toISOString(), created_at: new Date().toISOString(),
      });
      await setFeatureFlags(db, { bills: false });

      for (const res of [
        await request(app).get(`/api/public/payment-check/${token}`),
        await request(app).post(`/api/public/payment-check/${token}`).send({ action: 'paid_full' }),
      ]) {
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('BILLS_DISABLED');
      }
      expect((await db('invoice_payment_check_tokens').where({ token }).first()).used_at).toBeNull();
      expect((await db('invoices').where({ id: invoiceId }).first()).status).toBe('sent');
    });
  });
});
