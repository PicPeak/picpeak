/**
 * /disable overlapping an in-flight /enable (#1110).
 *
 * While activation generates an identity and writes its binding file the row
 * still reads `disabled`, so disable()'s conditional update matched nothing
 * and the lease conflict from its tick() was swallowed. The admin was told
 * participation was off, and the activation then completed and left it on —
 * an opt-out silently ignored, which is the one thing this feature cannot do.
 *
 * enable() now claims its state with a single conditional UPDATE that also
 * tests the cancellation flag, so whichever lands first wins outright.
 */
const knex = require('knex');
const { UsageService } = require('../../src/usage/UsageService');

const SECRET = 'z'.repeat(48);

// A report the envelope schema accepts. An empty payload fails validation
// during signing, so the packet would never reach the collector for reasons
// unrelated to what the test is checking.
function validReport() {
  const { FEATURE_KEYS } = require('../../src/usage/protocol.cjs');
  return {
    picpeak_version: '3.0.0',
    report_date: '2026-09-05',
    generated_at: '2026-09-05T00:00:00.000Z',
    features: Object.fromEntries(
      FEATURE_KEYS.map((k) => [k, { configured: false, used: false }])
    ),
    gallery_layouts: ['grid'],
  };
}

async function bootDb() {
  const db = knex({
    client: 'sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
  });
  await db.schema.createTable('product_usage_state', (t) => {
    t.integer('id').primary();
    t.string('status', 30).notNullable().defaultTo('disabled');
    t.boolean('notice_dismissed').notNullable().defaultTo(false);
    t.string('installation_id', 64);
    t.string('public_key', 59);
    t.text('private_key_encrypted');
    t.string('instance_binding', 64);
    t.bigInteger('sequence').notNullable().defaultTo(0);
    t.text('pending_packet');
    t.text('last_packet');
    t.text('last_receipt');
    t.string('last_report_date', 10);
    t.string('last_error', 80);
    t.text('feedback_preferences');
    t.string('lease_token', 36);
    t.bigInteger('lease_until').notNullable().defaultTo(0);
    t.bigInteger('cancel_seq').notNullable().defaultTo(0);
  });
  await db.schema.createTable('product_usage_markers', (t) => {
    t.string('feature', 60).primary();
  });
  await db('product_usage_state').insert({ id: 1 });
  return db;
}

/** A service whose binding() is slow, so the race window is controllable. */
function makeService(db, { onBinding } = {}) {
  const service = new UsageService(db, {
    secret: SECRET,
    endpoint: 'http://127.0.0.1:9/',
    fetch: async () => { throw new Error('collector must not be reached'); },
  });
  const realBinding = service.binding.bind(service);
  service.binding = async (create = false) => {
    if (create && onBinding) await onBinding();
    return realBinding === undefined ? 'x'.repeat(64) : 'b'.repeat(64);
  };
  return service;
}

describe('withdrawal during an in-flight activation', () => {
  let db;
  afterEach(async () => { if (db) await db.destroy(); db = null; });

  it('honours a /disable that lands while /enable is still generating its identity', async () => {
    db = await bootDb();
    let disableDone;
    const service = makeService(db, {
      // Fires inside enable(), before it claims the row — exactly the window
      // where the status still reads `disabled`.
      onBinding: async () => { disableDone = await service.disable(); },
    });

    await service.enable('usage-consent.v1');

    const row = await db('product_usage_state').where({ id: 1 }).first();
    expect(row.status).toBe('disabled');
    // Nothing was registered, so there is no identity and nothing to delete.
    expect(row.installation_id).toBeNull();
    expect(row.pending_packet).toBeNull();
    expect(disableDone.status).toBe('disabled');
  });

  it('activates normally when no withdrawal arrives', async () => {
    db = await bootDb();
    const service = makeService(db);
    await service.enable('usage-consent.v1');

    const row = await db('product_usage_state').where({ id: 1 }).first();
    // The collector is unreachable here, so it stops at activation_pending —
    // the point is that the claim succeeded and an identity exists.
    expect(row.status).toBe('activation_pending');
    expect(row.installation_id).not.toBeNull();
  });

  it('does not let a stale cancellation veto a later deliberate opt-in', async () => {
    db = await bootDb();
    // A withdrawal from an earlier participation is already reflected in the
    // counter when this activation reads it, so it cannot veto anything.
    await db('product_usage_state').where({ id: 1 }).update({ cancel_seq: 7 });

    const service = makeService(db);
    await service.enable('usage-consent.v1');

    const row = await db('product_usage_state').where({ id: 1 }).first();
    expect(row.status).toBe('activation_pending');
    expect(row.installation_id).not.toBeNull();
  });

  it('honours a withdrawal even when an earlier one was never cleared', async () => {
    // The case a boolean could not express: a stale cancellation is already
    // set, and a fresh one lands mid-activation. With a flag both look the
    // same; with a counter the second increment is visible.
    db = await bootDb();
    await db('product_usage_state').where({ id: 1 }).update({ cancel_seq: 3 });

    const service = makeService(db, {
      onBinding: async () => { await service.disable(); },
    });
    await service.enable('usage-consent.v1');

    const row = await db('product_usage_state').where({ id: 1 }).first();
    expect(row.status).toBe('disabled');
    expect(row.installation_id).toBeNull();
  });

  it('does not dispatch a report when the withdrawal completes during preparation', async () => {
    // deliver() checks for a withdrawal before the binding lookup, which is
    // asynchronous. A /disable that COMPLETED during it used to have the
    // report sent anyway — not an already-in-flight request, but a new one
    // started after the operator had withdrawn.
    db = await bootDb();
    const posted = [];
    const service = new UsageService(db, {
      secret: SECRET,
      endpoint: 'http://127.0.0.1:9/',
      fetch: async (_url, init) => {
        posted.push(JSON.parse(init.body).packet.action);
        throw new Error('collector unreachable');
      },
    });
    const identity = require('../../src/usage/protocol.cjs').generateIdentity();
    await db('product_usage_state').where({ id: 1 }).update({
      status: 'active',
      installation_id: identity.installation_id,
      public_key: identity.public_key,
      private_key_encrypted: service.encrypt(identity.private_key),
      instance_binding: 'b'.repeat(64),
      sequence: 1,
      pending_packet: JSON.stringify(
        require('../../src/usage/protocol.cjs').makePacket(
          { installation_id: identity.installation_id },
          'report',
          2,
          validReport()
        )
      ),
    });
    // The withdrawal lands while the binding lookup is awaited.
    service.binding = async () => {
      await db('product_usage_state').where({ id: 1 }).update({
        status: 'deletion_pending', pending_packet: null,
      });
      return 'b'.repeat(64);
    };

    await service.deliver(await db('product_usage_state').where({ id: 1 }).first());

    expect(posted).not.toContain('report');
  });
});
