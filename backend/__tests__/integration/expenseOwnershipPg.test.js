'use strict';

/**
 * The owner rule of services/expenseAccess.js under concurrent requests, on
 * real PostgreSQL connections: the check and the write are one locked step,
 * so a request that was waiting while another admin took the row is answered
 * from the row as it is now. SQLite cannot show this, its single connection
 * runs the transactions one after the other.
 */

const knex = require('knex');
const { randomUUID } = require('crypto');
const pgUrl = process.env.PICPEAK_PG_TEST_URL;
jest.setTimeout(120000);

(pgUrl ? describe : describe.skip)('expense ownership under concurrent requests (PostgreSQL)', () => {
  let owner, db, schema, cleanup, service, crm, previousClient;
  const adminIds = {};
  const actors = {};
  const idOf = r => Number(r[0]?.id ?? r[0]);
  const addInbound = () => db('inbound_documents').insert({
    source: 'email', supplier_name: 'Mailbox AG', total_amount_minor: 5000, currency: 'CHF',
  }).returning('id').then(idOf);
  const as = (who, work) => crm.withCrmActor(actors[who], work).then(() => who, error => error.code || String(error));

  // Resolves once some connection waits for a lock the backend `pid` holds.
  async function blockedBy(pid) {
    const deadline = Date.now() + 20000;
    for (;;) {
      const { rows } = await owner.raw('select count(*)::int as n from pg_stat_activity where ?::int = any(pg_blocking_pids(pid))', [pid]);
      if (rows[0].n > 0) return;
      if (Date.now() > deadline) throw new Error('the concurrent request never reached the row lock');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }

  beforeAll(async () => {
    schema = `expense_owner_${randomUUID().replace(/-/g, '')}`;
    owner = knex({ client: 'pg', connection: pgUrl });
    await owner.schema.createSchema(schema);
    previousClient = process.env.DATABASE_CLIENT;
    process.env.DATABASE_CLIENT = 'pg';
    process.env.NODE_ENV = 'test';
    process.env.SKIP_S3_TESTS = 'true';
    jest.doMock('../../knexfile', () => ({ client: 'pg', connection: pgUrl, searchPath: [schema], pool: { min: 0, max: 12 } }));
    ({ db, cleanup } = await require('./helpers/crmDb').bootCrmDb());
    crm = require('../../src/database/crmAccess');
    service = require('../../src/services/expenseService');
    const role = await db('roles').where({ name: 'admin' }).first('id');
    expect(role).toBeTruthy();
    for (const who of ['owner', 'other']) {
      adminIds[who] = idOf(await db('admin_users').insert({
        username: `pg-${who}`, email: `pg-${who}@example.test`, password_hash: 'unused',
        role_id: role.id, is_active: true, must_change_password: false,
      }).returning('id'));
      actors[who] = await crm.loadCrmActor({ id: adminIds[who] });
      expect(actors[who].roleName).toBe('admin');
    }
  });
  afterAll(async () => {
    if (cleanup) await cleanup(); else if (db) await db.destroy();
    if (owner) { await owner.schema.dropSchema(schema, true); await owner.destroy(); }
    if (previousClient === undefined) delete process.env.DATABASE_CLIENT; else process.env.DATABASE_CLIENT = previousClient;
    jest.dontMock('../../knexfile');
  });

  test('an edit that waited while another admin claimed the invoice is refused and writes nothing', async () => {
    const id = await addInbound();
    const claim = await db.transaction();
    let outcome;
    try {
      const { rows: [{ pid }] } = await claim.raw('select pg_backend_pid() as pid');
      await claim('inbound_documents').where({ id }).update({ created_by_admin_id: adminIds.other });
      const edit = as('owner', () => service.updateInbound(id, { paymentReference: 'RF18 5390 0754 7034' }, adminIds.owner));
      await blockedBy(pid);
      await claim.commit();
      outcome = await edit;
    } finally {
      if (!claim.isCompleted()) await claim.rollback();
    }
    expect(outcome).toBe('INBOUND_NOT_FOUND');
    expect((await db('inbound_documents').where({ id }).first()).payment_reference).toBeNull();
  });

  test('a payment that waited while another admin claimed the invoice is refused and writes nothing', async () => {
    const id = await addInbound();
    const claim = await db.transaction();
    let outcome;
    try {
      const { rows: [{ pid }] } = await claim.raw('select pg_backend_pid() as pid');
      await claim('inbound_documents').where({ id }).update({ created_by_admin_id: adminIds.other });
      const pay = as('owner', () => service.markInboundSupplierPayment(id, { paid: true }, adminIds.owner));
      await blockedBy(pid);
      await claim.commit();
      outcome = await pay;
    } finally {
      if (!claim.isCompleted()) await claim.rollback();
    }
    expect(outcome).toBe('INBOUND_NOT_FOUND');
    expect((await db('inbound_documents').where({ id }).first()).supplier_paid).toBeFalsy();
  });

  test('two admins triaging the same untriaged invoice at once: one becomes its owner, the other is refused', async () => {
    const ids = [];
    for (let i = 0; i < 5; i += 1) ids.push(await addInbound());
    const triage = (who, id, disposition) => as(who, () => service.categorizeInbound(id, { disposition }, adminIds[who]));
    const results = await Promise.all(ids.map(id => Promise.all([
      triage('owner', id, 'eigener_aufwand'), triage('other', id, 'abgelehnt'),
    ])));
    for (const [i, pair] of results.entries()) {
      const winner = pair.find(result => result === 'owner' || result === 'other');
      expect([...pair].sort()).toEqual(['INBOUND_NOT_FOUND', winner].sort());
      const row = await db('inbound_documents').where({ id: ids[i] }).first();
      expect([Number(row.created_by_admin_id), row.disposition])
        .toEqual(winner === 'owner' ? [adminIds.owner, 'eigener_aufwand'] : [adminIds.other, 'abgelehnt']);
    }
  });
});
