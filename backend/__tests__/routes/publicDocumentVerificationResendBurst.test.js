/**
 * Parallel "send me a code" requests must not get past the resend throttle.
 *
 * The route checked the throttle and the service wrote the code row only after
 * the email went out, so requests arriving together all passed the check and
 * each sent an email: once a minute and five times an hour per link capped
 * sequential requests but not a burst aimed at the customer's inbox.
 *
 * Its own file on purpose: the verification routes' per-IP limiter is a
 * module-level instance, and a burst sharing a file with the other
 * verification tests would spend their request budget.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-doc-verify-resend-'));
process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(tmpDir, 'db.sqlite');
process.env.STORAGE_PATH = path.join(tmpDir, 'storage');
fs.mkdirSync(process.env.STORAGE_PATH, { recursive: true });
process.env.JWT_SECRET = process.env.JWT_SECRET || 'crm-route-test-secret';

const request = require('supertest');
const { bootCrmDb, seedMinimal, createPublicToken, buildRouteApp } = require('../integration/helpers/crmDb');

describe('public document verification under a burst of send requests', () => {
  let db;
  let cleanup;
  let app;
  let verification;
  let contractId;
  const sent = [];

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    const { customerId } = await seedMinimal(db);
    const inserted = await db('contracts').insert({
      contract_number: 'K-RESEND-0001',
      customer_account_id: customerId,
      issue_date: new Date().toISOString().slice(0, 10),
      status: 'sent',
      language: 'en',
      created_at: new Date().toISOString(),
    }).returning('id');
    contractId = inserted[0]?.id ?? inserted[0];

    verification = require('../../src/services/publicDocumentVerificationService');
    // A slow transport, like a real SMTP round-trip, so the requests overlap.
    jest.spyOn(verification, 'sendCodeEmail').mockImplementation(async (mail) => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      sent.push(mail);
    });
    app = buildRouteApp('/api/public/contracts', require('../../src/routes/publicContracts'));
  }, 120000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  it('sends one email for six parallel requests and throttles the rest', async () => {
    const token = await createPublicToken(db, 'contract_action_tokens', { contract_id: contractId });

    const results = await Promise.all(Array.from({ length: 6 }, () => request(app)
      .post(`/api/public/contracts/${token}/verification`)));

    const statuses = results.map((res) => res.status).sort();
    expect(statuses).toEqual([202, 429, 429, 429, 429, 429]);
    for (const res of results.filter((r) => r.status === 429)) {
      expect(res.body.code).toBe('VERIFICATION_RATE_LIMITED');
    }
    expect(sent).toHaveLength(1);
    const { n } = await db('public_document_verification_codes').count({ n: '*' }).first();
    expect(Number(n)).toBe(1);
  });
});
