/**
 * HTTP route tests for backend/src/routes/publicQuotes (P0 — #570).
 *
 * Public token guards (publicTokenGuards.loadActionToken) are the most
 * security-sensitive surface in the CRM module — these are the routes
 * a customer hits via the link in the quote email, reachable from any
 * IP with the raw token. A regression here means leaked tokens become
 * permanently usable, or worse, an expired token starts working again.
 *
 * Tests pin the contract documented in publicTokenGuards.js:
 *   - 404 on unknown token (and IP bad-attempt counter ticks)
 *   - 410 on expired token
 *   - 410 on NULL expiry (defensive — historical bug)
 *   - 429 after 20 invalid attempts from one IP
 *   - 200 + sanitised payload on valid token
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

// MUST set the test DB env BEFORE the first require of anything that
// pulls in db.js — knexfile reads TEST_DATABASE_PATH at module-init
// time. The helper's bootCrmDb also has to be called once per file
// because the db module is cached; calling it from a second describe
// would silently reuse (or kill) the first instance's connection pool.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-pubquotes-test-'));
process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(tmpDir, 'db.sqlite');
process.env.STORAGE_PATH = path.join(tmpDir, 'storage');
fs.mkdirSync(process.env.STORAGE_PATH, { recursive: true });
process.env.JWT_SECRET = process.env.JWT_SECRET || 'crm-route-test-secret';

const request = require('supertest');
const { bootCrmDb, seedMinimal, createPublicToken, buildRouteApp } = require('../integration/helpers/crmDb');
const tokenGuards = require('../../src/utils/publicTokenGuards');

describe('publicQuotes routes', () => {
  let db;
  let cleanup;
  let app;
  let customerId;
  let quoteId;

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    ({ customerId } = await seedMinimal(db));
    const inserted = await db('quotes').insert({
      quote_number: 'Q-TEST-0001',
      customer_account_id: customerId,
      currency: 'CHF',
      issue_date: new Date().toISOString().slice(0, 10),
      net_amount_minor: 10000,
      vat_amount_minor: 0,
      total_amount_minor: 10000,
      status: 'sent',
      language: 'de',
      created_at: new Date(),
    }).returning('id');
    quoteId = inserted[0]?.id ?? inserted[0];

    app = buildRouteApp('/api/public/quotes', require('../../src/routes/publicQuotes'));
  }, 60000);

  afterAll(async () => {
    if (cleanup) await cleanup();
  });

  // Clear the in-memory IP bad-attempts map between scenarios so the
  // lockout test starts from a known state — and so it doesn't bleed
  // 429s into the unrelated tests that follow.
  beforeEach(() => {
    if (tokenGuards._internal?.badAttempts) {
      tokenGuards._internal.badAttempts.clear();
    }
  });

  describe('GET /:token', () => {
    it('returns 404 for an unknown but well-formed token', async () => {
      const fakeToken = 'a'.repeat(64);
      const res = await request(app).get(`/api/public/quotes/${fakeToken}`);
      expect(res.status).toBe(404);
      expect(res.body.error).toBeTruthy();
    });

    it('rejects malformed (non-64-hex) tokens with 400', async () => {
      const res = await request(app).get('/api/public/quotes/not-a-real-token');
      expect(res.status).toBe(400);
    });

    it('returns 410 for a token whose expires_at is in the past', async () => {
      const past = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const token = await createPublicToken(db, 'quote_action_tokens', {
        quote_id: quoteId, expires_at: past,
      });
      const res = await request(app).get(`/api/public/quotes/${token}`);
      expect(res.status).toBe(410);
      expect(res.body.code).toBe('TOKEN_EXPIRED');
    });

    // The NULL-expiry guard in loadActionToken is intentionally
    // defensive but the current schema declares
    // quote_action_tokens.expires_at NOT NULL — so the defensive
    // branch is unreachable at the route level. Test it directly
    // against loadActionToken in a unit suite if you want coverage.

    it('returns 200 with a sanitised quote payload for a valid token', async () => {
      const token = await createPublicToken(db, 'quote_action_tokens', {
        quote_id: quoteId,
      });
      const res = await request(app).get(`/api/public/quotes/${token}`);
      expect(res.status).toBe(200);
      expect(res.body.quote).toBeDefined();
      // API uses camelCase on the public view (see publicQuoteView in
      // the route handler).
      expect(res.body.quote.quoteNumber).toBe('Q-TEST-0001');
      // Internal IDs / admin metadata must NOT appear on the public payload
      expect(res.body.quote.customer_account_id).toBeUndefined();
      expect(res.body.quote.customerAccountId).toBeUndefined();
      expect(res.body.quote.createdByAdminId).toBeUndefined();
    });

    it('locks the IP after 20 invalid token lookups (429 TOKEN_LOOKUP_LOCKED)', async () => {
      const fakeToken = 'b'.repeat(64);
      for (let i = 0; i < 20; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        const r = await request(app)
          .get(`/api/public/quotes/${fakeToken}`)
          .set('X-Forwarded-For', '203.0.113.10');
        expect(r.status).toBe(404);
      }
      const locked = await request(app)
        .get(`/api/public/quotes/${fakeToken}`)
        .set('X-Forwarded-For', '203.0.113.10');
      expect(locked.status).toBe(429);
      expect(locked.body.code).toBe('TOKEN_LOOKUP_LOCKED');
    }, 30000);
  });

  describe('POST /:token/respond', () => {
    it('rejects an invalid action (must be accept|decline) with 400', async () => {
      const token = await createPublicToken(db, 'quote_action_tokens', { quote_id: quoteId });
      const res = await request(app)
        .post(`/api/public/quotes/${token}/respond`)
        .send({ action: 'maybe' });
      expect(res.status).toBe(400);
    });

    it('returns 404 for an unknown token on respond', async () => {
      const fakeToken = 'c'.repeat(64);
      const res = await request(app)
        .post(`/api/public/quotes/${fakeToken}/respond`)
        .send({ action: 'accept' });
      expect(res.status).toBe(404);
    });

    it('returns 410 when the token has expired (service-side check)', async () => {
      // The POST path goes through quoteService.recordResponse rather
      // than loadActionToken, so the error shape can differ from the
      // GET expiry response — what matters is the HTTP status.
      const past = new Date(Date.now() - 1000);
      const token = await createPublicToken(db, 'quote_action_tokens', {
        quote_id: quoteId, expires_at: past,
      });
      const res = await request(app)
        .post(`/api/public/quotes/${token}/respond`)
        .send({ action: 'accept' });
      expect(res.status).toBe(410);
    });
  });
});
