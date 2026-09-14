/**
 * Parallel wrong guesses must not get past the five-attempt limit.
 *
 * confirmCode used to read a code's attempt count, run the bcrypt compare,
 * and only then write the count back. Requests arriving together all read the
 * same count, so each of them got a compare: the limit capped sequential
 * guessing but not a burst, and only the per-IP request limiter stood between
 * a distributed attacker and the six-digit code.
 *
 * Its own file on purpose: the verification routes' per-IP limiter is a
 * module-level instance, and a burst sharing a file with the other
 * verification tests would spend their request budget.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-doc-verify-burst-'));
process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(tmpDir, 'db.sqlite');
process.env.STORAGE_PATH = path.join(tmpDir, 'storage');
fs.mkdirSync(process.env.STORAGE_PATH, { recursive: true });
process.env.JWT_SECRET = process.env.JWT_SECRET || 'crm-route-test-secret';

const request = require('supertest');
const bcrypt = require('bcrypt');
const { bootCrmDb, seedMinimal, createPublicToken, buildRouteApp } = require('../integration/helpers/crmDb');

describe('public document verification under a burst of guesses', () => {
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
      contract_number: 'K-BURST-0001',
      customer_account_id: customerId,
      issue_date: new Date().toISOString().slice(0, 10),
      status: 'sent',
      language: 'en',
      created_at: new Date().toISOString(),
    }).returning('id');
    contractId = inserted[0]?.id ?? inserted[0];

    verification = require('../../src/services/publicDocumentVerificationService');
    jest.spyOn(verification, 'sendCodeEmail').mockImplementation(async (mail) => { sent.push(mail); });
    app = buildRouteApp('/api/public/contracts', require('../../src/routes/publicContracts'));
  }, 120000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  it('lets at most five parallel wrong guesses reach the compare, then burns the code', async () => {
    const token = await createPublicToken(db, 'contract_action_tokens', { contract_id: contractId });
    expect((await request(app).post(`/api/public/contracts/${token}/verification`)).status).toBe(202);
    const { code } = sent[0];
    const wrong = code === '000000' ? '111111' : '000000';
    const confirm = (value) => request(app)
      .post(`/api/public/contracts/${token}/verification/confirm`)
      .send({ code: value });
    const compare = jest.spyOn(bcrypt, 'compare');

    const results = await Promise.all(Array.from({ length: 8 }, () => confirm(wrong)));

    expect(compare.mock.calls.length).toBeLessThanOrEqual(5);
    for (const res of results) {
      expect([400, 429]).toContain(res.status);
      expect(res.body.code).toMatch(/^VERIFICATION_/);
    }
    // The limit was reached, so even the right code no longer opens the link.
    const late = await confirm(code);
    expect(late.status).toBe(410);
    expect(late.body.code).toBe('VERIFICATION_CODE_EXPIRED');
  });

  it('redeems a correct code once, however many requests submit it together', async () => {
    const token = await createPublicToken(db, 'contract_action_tokens', { contract_id: contractId });
    sent.length = 0;
    expect((await request(app).post(`/api/public/contracts/${token}/verification`)).status).toBe(202);
    const { code } = sent[0];

    const results = await Promise.all(Array.from({ length: 5 }, () => request(app)
      .post(`/api/public/contracts/${token}/verification/confirm`)
      .send({ code })));

    expect(results.filter((res) => res.status === 200)).toHaveLength(1);
    for (const res of results.filter((r) => r.status !== 200)) {
      expect(res.body.code).toMatch(/^VERIFICATION_/);
    }
  });
});
