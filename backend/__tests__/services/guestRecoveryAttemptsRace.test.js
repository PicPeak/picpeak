/**
 * A guest recovery code allows five guesses, even when they arrive together.
 *
 * verifyCode read the attempt counter, ran bcrypt.compare and then wrote
 * `attempts + 1`, so concurrent wrong guesses all passed the limit and counted
 * as a single attempt, and two correct submissions could both be accepted.
 * The attempt is now claimed in one conditional UPDATE before the compare and
 * the code is consumed only once.
 */
const { bootCrmDb } = require('../integration/helpers/crmDb');

jest.setTimeout(120000);

let db;
let cleanup;
let guestRecovery;
let eventId;

beforeAll(async () => {
  ({ db, cleanup } = await bootCrmDb());
  // Under jest a service's `new Date()` binds as a foreign-realm Date that
  // node-sqlite3 stringifies; normalise bindings the same way the other
  // service-level suites do.
  const clientProto = Object.getPrototypeOf(db.client);
  const origQuery = clientProto._query;
  clientProto._query = function patchedQuery(connection, obj) {
    if (obj && Array.isArray(obj.bindings)) {
      obj.bindings = obj.bindings.map(
        (b) => (b && typeof b === 'object' && typeof b.toISOString === 'function' ? b.toISOString() : b),
      );
    }
    return origQuery.call(this, connection, obj);
  };
  const [row] = await db('events').insert({
    slug: 'guest-recovery-race',
    event_type: 'wedding',
    event_name: 'Guest recovery race',
    event_date: '2026-01-01',
    host_email: 'h@example.com',
    admin_email: 'a@example.com',
    password_hash: 'x',
    share_link: 'guest-recovery-race-share',
    expires_at: new Date(Date.now() + 86400000).toISOString(),
  }).returning('id');
  eventId = row?.id ?? row;
  guestRecovery = require('../../src/services/guestRecoveryService');
});

afterAll(async () => { if (cleanup) await cleanup(); });

describe('guest recovery code attempts under concurrent requests', () => {
  it('refuses the right code after more wrong guesses than the limit, sent at once', async () => {
    const email = 'burst@example.com';
    const code = await guestRecovery.createCode(eventId, email);
    const wrong = code === '000000' ? '111111' : '000000';

    const results = await Promise.all(Array.from({ length: 10 }, () => (
      guestRecovery.verifyCode(eventId, email, wrong)
    )));

    expect(results.filter((r) => r.reason === 'wrong_code').length).toBeLessThanOrEqual(guestRecovery.MAX_ATTEMPTS);
    const stored = await db('guest_verification_codes').where({ event_id: eventId, email }).first();
    expect(Number(stored.attempts)).toBe(guestRecovery.MAX_ATTEMPTS);
    expect((await guestRecovery.verifyCode(eventId, email, code)).ok).toBe(false);
  });

  it('accepts the right code once when it is submitted twice at the same time', async () => {
    const email = 'twice@example.com';
    const code = await guestRecovery.createCode(eventId, email);

    const results = await Promise.all([
      guestRecovery.verifyCode(eventId, email, code),
      guestRecovery.verifyCode(eventId, email, code),
    ]);

    expect(results.filter((r) => r.ok)).toHaveLength(1);
  });

  it('still accepts the right code after fewer wrong guesses than the limit', async () => {
    const email = 'patient@example.com';
    const code = await guestRecovery.createCode(eventId, email);
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < guestRecovery.MAX_ATTEMPTS - 1; i += 1) {
      expect((await guestRecovery.verifyCode(eventId, email, wrong)).reason).toBe('wrong_code');
    }

    expect((await guestRecovery.verifyCode(eventId, email, code)).ok).toBe(true);
  });
});
