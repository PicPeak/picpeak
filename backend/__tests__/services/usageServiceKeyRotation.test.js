/**
 * The signing key is encrypted with USAGE_ENCRYPTION_KEY, which defaults to
 * JWT_SECRET. Rotating JWT_SECRET — the correct response to a suspected
 * compromise — makes that key unreadable.
 *
 * Before this was named, the failure surfaced as a generic DELIVERY_FAILED
 * that retried forever, and it silently blocked the DELETE packet as well:
 * an operator who asked to withdraw had their local state cleared while the
 * collector kept its copy, with nothing in the UI explaining why.
 */
const knex = require('knex');
const { UsageService } = require('../../src/usage/UsageService');

const SECRET_A = 'a'.repeat(48);
const SECRET_B = 'b'.repeat(48);

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
    t.text('privacy_receipts');
    t.string('last_report_date', 10);
    t.string('last_error', 80);
    t.text('feedback_preferences');
    t.string('lease_token', 36);
    t.bigInteger('lease_until').notNullable().defaultTo(0);
  });
  await db('product_usage_state').insert({ id: 1 });
  return db;
}

describe('usage signing key becomes unreadable after secret rotation', () => {
  let db;
  afterEach(async () => { if (db) await db.destroy(); db = null; });

  it('names the failure instead of reporting a generic decrypt error', async () => {
    db = await bootDb();
    const before = new UsageService(db, { secret: SECRET_A });
    const sealed = before.encrypt('the-signing-key');

    // Same value, different secret — exactly what rotating JWT_SECRET does.
    const after = new UsageService(db, { secret: SECRET_B });
    expect(() => after.decrypt(sealed)).toThrow(
      expect.objectContaining({ code: 'SIGNING_KEY_UNREADABLE' })
    );
  });

  it('still round-trips under the unrotated secret', async () => {
    db = await bootDb();
    const service = new UsageService(db, { secret: SECRET_A });
    expect(service.decrypt(service.encrypt('the-signing-key'))).toBe('the-signing-key');
  });

  it('records SIGNING_KEY_UNREADABLE rather than DELIVERY_FAILED, and does not flag an identity conflict', async () => {
    db = await bootDb();
    const sealed = new UsageService(db, { secret: SECRET_A }).encrypt('key');
    await db('product_usage_state').where({ id: 1 }).update({
      status: 'active',
      installation_id: 'a'.repeat(64),
      public_key: 'p'.repeat(59),
      private_key_encrypted: sealed,
      sequence: 1,
      pending_packet: JSON.stringify({
        action: 'delete', packet_id: 'x', installation_id: 'a'.repeat(64), sequence: 1,
      }),
    });

    const service = new UsageService(db, {
      secret: SECRET_B,
      endpoint: 'http://127.0.0.1:9/',
      // A delivery must never be attempted: signing fails first.
      fetch: () => { throw new Error('network must not be reached'); },
    });
    await service.deliver(await db('product_usage_state').where({ id: 1 }).first());

    const row = await db('product_usage_state').where({ id: 1 }).first();
    expect(row.last_error).toBe('SIGNING_KEY_UNREADABLE');
    // A key we cannot read is not evidence of a cloned installation.
    expect(row.status).toBe('active');
  });
});
