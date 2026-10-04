/**
 * PostgreSQL test for the payment-check issuance lock.
 * Gated: runs only when PICPEAK_PG_TEST_URL points at a throwaway Postgres DB,
 * e.g.
 *   PICPEAK_PG_TEST_URL="postgres://picpeak:picpeak_secure_pass_2024@127.0.0.1:7102/picpeak_test_lock" \
 *     npx jest __tests__/integration/paymentCheckIssuanceLockPg.test.js
 *
 * queuePaymentCheckEmail serialises issuances per invoice. In one process a
 * promise chain does that; across replicas it relies on
 * pg_advisory_xact_lock(<class>, <invoice id>), a branch the SQLite suites
 * never execute. A second knex pool stands in for the other replica here.
 * No tables are needed: the lock is not a row lock.
 */
const knex = require('knex');

const PG_URL = process.env.PICPEAK_PG_TEST_URL;
const maybe = PG_URL ? describe : describe.skip;

jest.mock('../../src/database/db', () => {
  const makeKnex = require('knex');
  const url = process.env.PICPEAK_PG_TEST_URL;
  // Without the URL the suite is skipped; the module still has to load.
  return { db: url ? makeKnex({ client: 'pg', connection: url, pool: { min: 0, max: 4 } }) : jest.fn() };
});

maybe('payment-check issuance lock on Postgres', () => {
  let db; let otherReplica; let lock; let LOCK_CLASS;
  const INVOICE = 4242;
  const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  beforeAll(() => {
    ({ db } = require('../../src/database/db'));
    otherReplica = knex({ client: 'pg', connection: PG_URL, pool: { min: 0, max: 2 } });
    const { _internal } = require('../../src/services/invoice/payments');
    lock = _internal.withPaymentCheckIssuanceLock;
    LOCK_CLASS = _internal.PAYMENT_CHECK_ISSUANCE_LOCK;
  });

  afterAll(async () => {
    await otherReplica.destroy();
    await db.destroy();
  });

  test('takes the advisory lock and runs the issuance', async () => {
    const seen = await lock(INVOICE, async () => {
      // Visible from another session while the issuance runs.
      const rows = await otherReplica('pg_locks')
        .where({ locktype: 'advisory', classid: LOCK_CLASS, objid: INVOICE, granted: true });
      return rows.length;
    });
    expect(seen).toBe(1);
    // Transaction-scoped: gone once the issuance has returned.
    const after = await otherReplica('pg_locks').where({ locktype: 'advisory', classid: LOCK_CLASS, objid: INVOICE });
    expect(after).toHaveLength(0);
  });

  test('waits while another replica holds the lock for the same invoice', async () => {
    const order = [];
    let releaseOther;
    const held = new Promise((resolve) => { releaseOther = resolve; });
    let otherHasLock;
    const otherLocked = new Promise((resolve) => { otherHasLock = resolve; });
    const other = otherReplica.transaction(async (trx) => {
      await trx.raw('SELECT pg_advisory_xact_lock(?, ?)', [LOCK_CLASS, INVOICE]);
      order.push('other:locked');
      otherHasLock();
      await held;
      order.push('other:done');
    });
    await otherLocked;

    const mine = lock(INVOICE, async () => { order.push('mine:ran'); });
    await tick(300);
    expect(order).toEqual(['other:locked']);

    releaseOther();
    await Promise.all([other, mine]);
    expect(order).toEqual(['other:locked', 'other:done', 'mine:ran']);
  });

  test('a different invoice is not held back', async () => {
    let releaseOther;
    const held = new Promise((resolve) => { releaseOther = resolve; });
    let otherHasLock;
    const otherLocked = new Promise((resolve) => { otherHasLock = resolve; });
    const other = otherReplica.transaction(async (trx) => {
      await trx.raw('SELECT pg_advisory_xact_lock(?, ?)', [LOCK_CLASS, INVOICE]);
      otherHasLock();
      await held;
    });
    await otherLocked;
    await expect(lock(INVOICE + 1, async () => 'ran')).resolves.toBe('ran');
    releaseOther();
    await other;
  });

  test('releases the lock when the issuance throws', async () => {
    await expect(lock(INVOICE, async () => { throw new Error('queue down'); })).rejects.toThrow('queue down');
    const after = await otherReplica('pg_locks').where({ locktype: 'advisory', classid: LOCK_CLASS, objid: INVOICE });
    expect(after).toHaveLength(0);
    await expect(lock(INVOICE, async () => 'again')).resolves.toBe('again');
  });
});
