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
const { generateIdentity, makePacket } = require('../../src/usage/protocol.cjs');

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
    t.string('consent_version', 40).notNullable().defaultTo('usage-consent.v1');
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
    t.integer('attempts').notNullable().defaultTo(0);
    t.bigInteger('next_attempt_at').notNullable().defaultTo(0);
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

/**
 * Naming the failure told the operator what happened but left them nowhere to
 * go: the delete packet can never be signed, so the row stays in
 * deletion_pending forever, and enable() refuses because it is not `disabled`.
 * An operator who rotated the secret precisely because it was compromised
 * cannot restore it, so without an exit the feature is bricked.
 */
describe('abandoning a withdrawal that can never be signed', () => {
  let db;
  afterEach(async () => { if (db) await db.destroy(); db = null; });

  const stuck = async () => {
    db = await bootDb();
    await db.schema.createTable('product_usage_markers', (t) => {
      t.string('feature', 60).primary();
    });
    await db('product_usage_markers').insert({ feature: 'crm' });
    await db('product_usage_state').where({ id: 1 }).update({
      status: 'deletion_pending',
      installation_id: 'a'.repeat(64),
      public_key: 'p'.repeat(59),
      private_key_encrypted: new UsageService(db, { secret: SECRET_A }).encrypt('key'),
      sequence: 4,
      last_error: 'SIGNING_KEY_UNREADABLE',
    });
    return new UsageService(db, {
      secret: SECRET_B,
      endpoint: 'https://usage.example.test',
      bindingPath: `${require('os').tmpdir()}/usage-abandon-${Date.now()}.key`,
      fetch: () => { throw new Error('network must not be reached'); },
    });
  };

  it('clears the local identity and records the deletion as unconfirmed', async () => {
    const service = await stuck();
    const status = await service.abandon();

    expect(status.status).toBe('disabled');
    expect(status.installation_id).toBeNull();
    const row = await db('product_usage_state').where({ id: 1 }).first();
    expect(row.private_key_encrypted).toBeNull();
    expect(row.public_key).toBeNull();
    expect(row.last_error).toBeNull();
    expect(await db('product_usage_markers').count('* as c').first()).toEqual({ c: 0 });

    // The receipt must not claim a deletion the collector never confirmed.
    const receipt = JSON.parse(row.privacy_receipts).last_abandonment;
    expect(receipt.status).toBe('collector-unconfirmed');
    expect(receipt.reason).toBe('SIGNING_KEY_UNREADABLE');
    expect(receipt.installation_id).toBe('a'.repeat(64));
  });

  it('lets the operator rejoin afterwards', async () => {
    const service = await stuck();
    await service.abandon();
    expect((await service.state()).status).toBe('disabled');
  });

  it('refuses on a withdrawal that is merely undelivered', async () => {
    const service = await stuck();
    await db('product_usage_state').where({ id: 1 }).update({ last_error: 'DELIVERY_FAILED' });
    await expect(service.abandon()).rejects.toThrow(/abandoned/);
    expect((await service.state()).installation_id).toBe('a'.repeat(64));
  });

  it('refuses while participation is active', async () => {
    const service = await stuck();
    await db('product_usage_state').where({ id: 1 }).update({ status: 'active' });
    await expect(service.abandon()).rejects.toThrow(/abandoned/);
    expect((await service.state()).installation_id).toBe('a'.repeat(64));
  });
});

/**
 * Every failed delivery used to be retried on the next admin request, and
 * /activity is open to any authenticated admin while the settings ticker fires
 * it every five minutes per open tab. A permanently rejected packet therefore
 * produced one collector request per admin action, indefinitely.
 */
describe('delivery backoff', () => {
  let db;
  afterEach(async () => { if (db) await db.destroy(); db = null; });

  // A real identity and a schema-valid packet, so the failure happens where
  // this test claims it does — at the network — rather than in signPacket.
  const activeWithPendingPacket = async (fetchImpl, now) => {
    db = await bootDb();
    await db.schema.createTable('product_usage_markers', (t) => {
      t.string('feature', 60).primary();
    });
    const service = new UsageService(db, {
      secret: SECRET_A,
      endpoint: 'https://usage.example.test',
      now: () => now(),
      fetch: fetchImpl,
    });
    const identity = generateIdentity();
    await db('product_usage_state').where({ id: 1 }).update({
      status: 'active',
      consent_version: 'usage-consent.v2',
      installation_id: identity.installation_id,
      public_key: identity.public_key,
      private_key_encrypted: service.encrypt(identity.private_key),
      sequence: 1,
      pending_packet: JSON.stringify(
        makePacket(identity, 'session', 2, {}, 'usage.v2')
      ),
    });
    return service;
  };

  it('paces the next unattended attempt after a failure, and lets Retry skip it', async () => {
    let clock = 1_000_000;
    let calls = 0;
    const service = await activeWithPendingPacket(() => {
      calls += 1;
      throw new Error('collector unreachable');
    }, () => clock);

    await service.tick();
    expect(calls).toBe(1);
    const paced = await service.state();
    expect(Number(paced.attempts)).toBe(1);
    expect(Number(paced.next_attempt_at)).toBeGreaterThan(clock);

    // The unattended callers — /activity and the settings ticker — wait.
    await service.tick();
    await service.tick();
    expect(calls).toBe(1);

    // The operator pressing Retry does not.
    await service.tick({ force: true });
    expect(calls).toBe(2);
    expect(Number((await service.state()).attempts)).toBe(2);

    // Once the window passes, the automatic sender tries again on its own.
    clock = Number((await service.state()).next_attempt_at) + 1;
    await service.tick();
    expect(calls).toBe(3);
  });

  it('grows the wait with consecutive failures and caps it at an hour', () => {
    const service = new UsageService(null, { secret: SECRET_A, endpoint: 'https://usage.example.test' });
    expect(service.backoffMs(1)).toBe(2 * 60000);
    expect(service.backoffMs(3)).toBe(8 * 60000);
    expect(service.backoffMs(20)).toBe(60 * 60000);
  });

  it('clears the pacing once a packet is accepted', async () => {
    const clock = 1_000_000;
    const service = await activeWithPendingPacket(async () => {
      throw new Error('collector unreachable');
    }, () => clock);
    await service.tick();
    expect(Number((await service.state()).attempts)).toBe(1);

    await service.clearDeliveryBackoff();
    const cleared = await service.state();
    expect(Number(cleared.attempts)).toBe(0);
    expect(Number(cleared.next_attempt_at)).toBe(0);
  });
});
