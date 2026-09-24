'use strict';

// The bad-code lockout on the public upload endpoint was keyed on the full
// client address while the rate limiter counts an IPv6 /64 as one client, so
// a guesser rotating addresses inside one allocation reset its own count.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-characters-long!!';

const request = require('supertest');
const { bootCrmDb, buildRouteApp } = require('../integration/helpers/crmDb');
// Required after bootCrmDb, which points the database module at the temp DB.
let db, cleanup, app, guards;

beforeAll(async () => {
  ({ db, cleanup } = await bootCrmDb());
  const flag = await db('feature_flags').where({ key: 'transfers' }).first();
  if (flag) await db('feature_flags').where({ key: 'transfers' }).update({ value: true });
  else await db('feature_flags').insert({ key: 'transfers', value: true });
  ({ _internal: guards } = require('../../src/utils/publicTokenGuards'));
  app = buildRouteApp('/api/public/transfer-upload', require('../../src/routes/publicTransferUpload'));
}, 120000);

beforeEach(() => guards.badAttempts.clear());
afterAll(async () => { if (cleanup) await cleanup(); });

const probe = (ip) => request(app).get('/api/public/transfer-upload/NOSUCH1').set('X-Forwarded-For', ip);

test('bad codes from one IPv6 /64 lock the whole /64, not only the address that guessed', async () => {
  for (let i = 0; i < guards.BAD_ATTEMPT_LIMIT; i++) {
    expect((await probe(`2001:db8:1:1::${(i + 1).toString(16)}`)).status).toBe(404);
  }
  expect((await probe('2001:db8:1:1::ffff')).status).toBe(429);
  // A different /64 is a different client.
  expect((await probe('2001:db8:1:2::1')).status).toBe(404);
});
