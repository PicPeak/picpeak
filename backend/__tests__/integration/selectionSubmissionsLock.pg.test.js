/**
 * The viewer lock behind "Finish selection" (issue 1733, A1) on PostgreSQL.
 *
 * SQLite serialises on its one connection, which the integration suite
 * covers. On PostgreSQL the same guarantee is a transaction-scoped advisory
 * lock, and only a real server can show that it holds a second request of
 * the same guest back while leaving every other guest alone.
 */
const knex = require('knex');

const pgUrl = process.env.PICPEAK_PG_TEST_URL;
const pg = pgUrl ? describe : describe.skip;

pg('PostgreSQL viewer lock for selection submissions', () => {
  let db; let selectionSubmissions;

  beforeAll(() => {
    db = knex({ client: 'pg', connection: pgUrl, pool: { min: 0, max: 4 } });
    jest.doMock('../../src/database/db', () => ({ db, logActivity: jest.fn() }));
    selectionSubmissions = require('../../src/services/selectionSubmissions');
  });
  afterAll(async () => { if (db) await db.destroy(); });

  // Requests parked on this guest's lock: the lock's two keys, as pg_locks
  // shows them (0x53656c53 is the service's lock class).
  const waiting = async () => {
    const { rows } = await db.raw(
      'SELECT count(*) AS n FROM pg_locks WHERE locktype = ? AND NOT granted '
      + 'AND classid = ? AND objid = hashtext(?)::oid',
      ['advisory', 0x53656c53, '424242:lock-test-guest'],
    );
    return Number(rows[0].n);
  };

  test('holds the same guest back until the first commits, and nobody else', async () => {
    const order = [];
    const viewer = { guestId: null, guestIdentifier: 'lock-test-guest' };
    let release; const held = new Promise((resolve) => { release = resolve; });
    let entered; const inside = new Promise((resolve) => { entered = resolve; });

    const first = selectionSubmissions.withViewerLock(424242, viewer, async () => {
      order.push('first in');
      entered();
      await held;
      order.push('first out');
    });
    await inside;
    const second = selectionSubmissions.withViewerLock(424242, viewer, async () => { order.push('second in'); });

    // Another guest of the gallery, and the same identifier in another one.
    await selectionSubmissions.withViewerLock(424242, { guestIdentifier: 'lock-test-other' }, async () => { order.push('other guest'); });
    await selectionSubmissions.withViewerLock(424243, viewer, async () => { order.push('other gallery'); });

    // The second request is parked on the lock, not merely not started yet.
    const deadline = Date.now() + 10000;
    while ((await waiting()) === 0 && Date.now() < deadline) {
      await new Promise((resolve) => { setTimeout(resolve, 50); });
    }
    expect(await waiting()).toBe(1);
    expect(order).toEqual(['first in', 'other guest', 'other gallery']);

    release();
    await Promise.all([first, second]);
    expect(order).toEqual(['first in', 'other guest', 'other gallery', 'first out', 'second in']);
  });
});
