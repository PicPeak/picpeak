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
    t.boolean('cancel_requested').notNullable().defaultTo(false);
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
    await db('product_usage_state').where({ id: 1 }).update({ cancel_requested: true });

    const service = makeService(db);
    await service.enable('usage-consent.v1');

    const row = await db('product_usage_state').where({ id: 1 }).first();
    expect(row.status).toBe('activation_pending');
    expect(row.installation_id).not.toBeNull();
  });
});
