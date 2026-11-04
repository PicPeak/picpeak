/**
 * Erasure of a holder racing the removal of the same address as a contact at
 * another customer, on PostgreSQL (issue 2375).
 *
 * keepHolderLogin copies the erased holder's password into customer_logins
 * when the address is a contact elsewhere. Without a lock on the address, it
 * saw a contact row whose removal had not committed yet (and deleteContact saw
 * a holder whose erasure had not), and the login row outlived every contact
 * that could lead to it. Both now take pg_advisory_xact_lock on the address.
 *
 * Gated on PICPEAK_PG_TEST_URL; runs the core migrations in a schema of its
 * own and drops it afterwards.
 */
const pgUrl = process.env.PICPEAK_PG_TEST_URL;

const held = [];
const restores = [];

(pgUrl ? describe : describe.skip)('contact removal against erasure on PostgreSQL (issue 2375)', () => {
  let owner; let db; let teardown;
  let contacts; let accounts; let blockedOnLock;
  let counter = 0;

  beforeAll(async () => {
    ({ blockedOnLock } = require('./helpers/pgLockOrder'));
    ({ owner, db, teardown } = await require('./helpers/pgLockOrder').bootPgSchema(pgUrl, 'contact_race'));
    contacts = require('../../src/services/customerContactsService');
    accounts = require('../../src/services/customerAccountsService');
  }, 180000);

  afterAll(async () => { if (teardown) await teardown(); });

  afterEach(() => {
    while (held.length) held.pop()();
    while (restores.length) restores.pop()();
  });

  async function customer(email) {
    const [row] = await db('customer_accounts').insert({
      email,
      password_hash: 'holder-hash',
      password_changed_at: new Date().toISOString(),
      is_active: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).returning('id');
    return typeof row === 'object' ? row.id : row;
  }

  // The next db.transaction runs its work, then waits for release() before it
  // commits. `ready` resolves once the work is done.
  function holdNextTransaction() {
    // db is a read-only Proxy over the knex instance; its client is the
    // object that runs every transaction.
    const { client } = db;
    const original = client.transaction;
    let release; let markReady;
    const gate = new Promise((resolve) => { release = resolve; held.push(resolve); });
    const ready = new Promise((resolve) => { markReady = resolve; });
    client.transaction = function holdOnce(work, ...rest) {
      client.transaction = original;
      return original.call(this, async (trx) => {
        const result = await work(trx);
        markReady();
        await gate;
        return result;
      }, ...rest);
    };
    restores.push(() => { client.transaction = original; });
    return { ready, release };
  }

  async function setup() {
    counter += 1;
    const address = `both${counter}@example.test`;
    const erasedId = await customer(address);
    const otherId = await customer(`other${counter}@example.test`);
    const contact = await contacts.createContact(otherId, { email: address }, null);
    return { address, erasedId, otherId, contact };
  }

  it('leaves no login when the removal holds its transaction open first', async () => {
    const { address, erasedId, otherId, contact } = await setup();

    const removal = holdNextTransaction();
    const removing = contacts.deleteContact(otherId, contact.id, null);
    await removal.ready;

    const erasing = accounts.eraseCustomer(erasedId, null);
    await blockedOnLock(owner, erasing);
    removal.release();
    await Promise.all([removing, erasing]);

    expect(await db('customer_contacts').whereRaw('LOWER(email) = ?', [address])).toEqual([]);
    expect(await db('customer_logins').where('email', address)).toEqual([]);
  });

  it('leaves no login when the erasure holds its transaction open first', async () => {
    const { address, erasedId, otherId, contact } = await setup();

    const erasure = holdNextTransaction();
    const erasing = accounts.eraseCustomer(erasedId, null);
    await erasure.ready;

    const removing = contacts.deleteContact(otherId, contact.id, null);
    await blockedOnLock(owner, removing);
    erasure.release();
    await Promise.all([erasing, removing]);

    expect(await db('customer_contacts').whereRaw('LOWER(email) = ?', [address])).toEqual([]);
    expect(await db('customer_logins').where('email', address)).toEqual([]);
  });

  it('still keeps the login of an erased holder who stays a contact', async () => {
    const { address, erasedId } = await setup();
    await accounts.eraseCustomer(erasedId, null);
    const [login] = await db('customer_logins').where('email', address);
    expect(login.password_hash).toBe('holder-hash');
  });

  it('does not deadlock with a password reset that holds one of the erased contacts', async () => {
    const { erasedId } = await setup();
    const own = await contacts.createContact(erasedId, { email: `own${counter}@example.test` }, null);
    // As createPasswordReset does: the contact row first, then a row that
    // references the account.
    const reset = await db.transaction();
    try {
      await reset('customer_contacts').where('id', own.id).forUpdate().first('id');
      const erasing = accounts.eraseCustomer(erasedId, null);
      await blockedOnLock(owner, erasing);
      await reset('customer_password_resets').insert({
        ...require('../../src/utils/capabilityToken').capabilityTokenColumns(require('crypto').randomBytes(32).toString('hex')),
        customer_account_id: erasedId,
        contact_id: own.id,
        expires_at: new Date(Date.now() + 3600e3).toISOString(),
      });
      await reset.commit();
      await erasing;
    } finally {
      if (!reset.isCompleted()) await reset.rollback();
    }
    expect(await db('customer_password_resets').where('customer_account_id', erasedId)).toEqual([]);
  });
});
