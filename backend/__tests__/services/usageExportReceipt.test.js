/**
 * Two things the participant is entitled to have stated exactly.
 *
 * The export receipt is a privacy document — the artefact an operator shows a
 * third party — so a count in it has to mean what its label says. It counted
 * every packet in the participation (feedback, votes, portal sessions, the
 * registration) and called the total "usage reports": an install that had sent
 * one report and twenty feedback items reported twenty-one reports.
 *
 * The delete packet's sequence is the other: it reuses the last ACCEPTED
 * sequence rather than taking the next one, unlike every other action. That is
 * a contract with the collector, not an implementation detail — if the
 * collector ever enforced strictly increasing sequences per installation, the
 * withdrawal would be rejected forever and the operator could never leave. It
 * is pinned here so the assumption is written down and a change to it has to
 * be deliberate.
 */
const knex = require('knex');
const { UsageService } = require('../../src/usage/UsageService');
const { generateIdentity, verifyEnvelope } = require('../../src/usage/protocol.cjs');

const SECRET = 's'.repeat(48);

async function bootDb() {
  const db = knex({
    client: 'sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
  });
  await db.schema.createTable('product_usage_state', (t) => {
    t.integer('id').primary();
    t.string('status', 30).notNullable().defaultTo('disabled');
    t.string('consent_version', 40).notNullable().defaultTo('usage-consent.v2');
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
    t.bigInteger('cancel_seq').notNullable().defaultTo(0);
    t.integer('attempts').notNullable().defaultTo(0);
    t.bigInteger('next_attempt_at').notNullable().defaultTo(0);
  });
  await db('product_usage_state').insert({ id: 1 });
  await db.schema.createTable('product_usage_markers', (t) => t.string('feature', 60).primary());
  return db;
}

const envelope = (action) => ({ packet: { action, installation_id: 'a'.repeat(64) } });

describe('the export receipt states what it actually counted', () => {
  let db;
  afterEach(async () => { if (db) await db.destroy(); db = null; });

  const exportWith = async (packets) => {
    db = await bootDb();
    await db('product_usage_state').where({ id: 1 }).update({
      status: 'active',
      installation_id: 'a'.repeat(64),
    });
    const service = new UsageService(db, {
      secret: SECRET,
      endpoint: 'https://usage.example.test',
      now: () => Date.parse('2026-09-06T12:00:00.000Z'),
      fetch: async () => ({
        ok: true,
        headers: { get: () => null },
        body: (async function* () {
          yield Buffer.from(JSON.stringify({ installation_id: 'a'.repeat(64), packets }));
        })(),
      }),
    });
    await service.export();
    return JSON.parse((await db('product_usage_state').where({ id: 1 }).first()).privacy_receipts)
      .last_export;
  };

  it('counts reports as reports and everything else separately', async () => {
    const receipt = await exportWith([
      envelope('register'),
      envelope('report'),
      envelope('consent'),
      envelope('feedback'),
      envelope('feedback'),
      envelope('vote'),
      envelope('session'),
    ]);
    expect(receipt.report_count).toBe(1);
    expect(receipt.packet_count).toBe(7);
    expect(receipt.scope).toEqual([
      'accepted usage reports',
      'accepted participant operations',
    ]);
  });

  it('reports zero rather than a total when no report was ever accepted', async () => {
    const receipt = await exportWith([envelope('register'), envelope('feedback')]);
    expect(receipt.report_count).toBe(0);
    expect(receipt.packet_count).toBe(2);
  });
});

describe('the delete packet reuses the last accepted sequence', () => {
  let db;
  afterEach(async () => { if (db) await db.destroy(); db = null; });

  it('sends the accepted sequence, not the next one', async () => {
    db = await bootDb();
    const identity = generateIdentity();
    const sent = [];
    const service = new UsageService(db, {
      secret: SECRET,
      endpoint: 'https://usage.example.test',
      now: () => Date.parse('2026-09-06T12:00:00.000Z'),
      bindingPath: `${require('os').tmpdir()}/usage-delete-seq-${Date.now()}.key`,
      fetch: async (_url, options) => {
        const body = JSON.parse(options.body);
        sent.push(verifyEnvelope(body, Date.parse('2026-09-06T12:00:00.000Z')));
        // Deliberately not a sequence-enforcing collector: this test pins what
        // PicPeak sends, and the collector contract is what must match it.
        throw new Error('stop after capturing the packet');
      },
    });
    await db('product_usage_state').where({ id: 1 }).update({
      status: 'deletion_pending',
      installation_id: identity.installation_id,
      public_key: identity.public_key,
      private_key_encrypted: service.encrypt(identity.private_key),
      sequence: 7,
    });

    await service.tick({ force: true });

    expect(sent).toHaveLength(1);
    expect(sent[0].action).toBe('delete');
    expect(sent[0].sequence).toBe(7);
  });
});
