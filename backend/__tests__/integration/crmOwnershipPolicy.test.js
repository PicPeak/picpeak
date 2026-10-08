'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const knex = require('knex');
const { installCrmAccess, withCrmActor, withTrustedCrmAccess, withoutCrmContext } = require('../../src/database/crmAccess');

const engines = ['sqlite3', ...(process.env.PICPEAK_PG_TEST_URL ? ['pg'] : [])];
const manage = ['quotes.view', 'quotes.manage', 'bills.view', 'bills.manage', 'contracts.view', 'contracts.manage'];
const actor = (id, permissions = manage, roleName = 'photographer') => ({ id, roleName, permissions: new Set(permissions) });

test.each(['test', 'production'])('NODE_ENV=%s alone never grants missing-context fixture authority', environment => {
  const script = `
    const knex = require('knex');
    const policy = require('./src/database/crmAccess');
    const conn = knex({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
    policy.installCrmAccess(conn.client);
    try { conn('quotes').select().toSQL(); process.exitCode = 1; }
    catch (error) { if (error.statusCode !== 403) throw error; }
    if (process.env.NODE_ENV === 'production') {
      try { policy.enterTrustedCrmFixtureContext(); process.exitCode = 1; }
      catch (error) { if (!error.message.includes('test-only')) throw error; }
    }
    conn.destroy();
  `;
  require('child_process').execFileSync(process.execPath, ['-e', script], {
    cwd: path.resolve(__dirname, '../..'), env: { ...process.env, NODE_ENV: environment }, timeout: 10000,
  });
});

describe.each(engines)('CRM query ownership (%s)', client => {
  let conn, dir, schema;
  const trusted = fn => withTrustedCrmAccess('isolated policy fixture', fn);
  const as = (principal, fn) => withCrmActor(principal, fn);

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-crm-policy-'));
    schema = `crm_policy_${process.pid}_${Date.now()}`;
    conn = knex(client === 'pg'
      ? { client, connection: process.env.PICPEAK_PG_TEST_URL, searchPath: [schema], pool: { min: 0, max: 3 } }
      : { client, connection: { filename: path.join(dir, 'policy.db') }, useNullAsDefault: true, pool: { min: 1, max: 1 } });
    installCrmAccess(conn.client);
    await trusted(async () => {
      if (client === 'pg') await conn.schema.createSchema(schema);
      for (const root of ['quotes', 'contracts', 'invoices']) {
        await conn.schema.createTable(root, t => {
          t.increments('id'); t.integer('created_by_admin_id'); t.string('deal_uuid'); t.string('status');
          t.integer('project_id'); t.integer('event_id'); t.integer('converted_event_id');
          t.integer('source_quote_id'); t.integer('source_contract_id'); t.integer('converted_contract_id');
          t.integer('replaces_quote_id'); t.integer('cancels_invoice_id'); t.integer('replaces_invoice_id'); t.integer('cancellation_storno_id');
        });
      }
      await conn.schema.createTable('projects', t => { t.increments('id'); t.integer('created_by'); });
      await conn.schema.createTable('events', t => { t.increments('id'); t.integer('created_by'); t.integer('project_id'); });
      await conn.schema.createTable('quote_line_items', t => { t.increments('id'); t.integer('quote_id'); t.string('description'); });
      await conn.schema.createTable('invoice_payment_log', t => { t.increments('id'); t.integer('invoice_id'); t.integer('amount_minor'); });
      await conn.schema.createTable('contract_signers', t => { t.increments('id'); t.integer('contract_id'); t.string('name'); });
      await conn.schema.createTable('contract_signing_sessions', t => { t.increments('id'); t.integer('signer_id'); t.string('token'); });
      await conn.schema.createTable('generated_documents', t => { t.increments('id'); t.string('doc_type'); t.integer('doc_id'); t.string('path'); });
      await conn.schema.createTable('accounting_change_history', t => { t.increments('id'); t.string('document_type'); t.integer('document_id'); t.string('action'); });
      await conn.schema.createTable('customer_documents', t => { t.increments('id'); t.integer('contract_id'); t.string('name'); });
    });
  });

  beforeEach(() => trusted(async () => {
    for (const t of ['customer_documents', 'accounting_change_history', 'generated_documents', 'contract_signing_sessions',
      'contract_signers', 'invoice_payment_log', 'quote_line_items', 'quotes', 'contracts', 'invoices', 'events', 'projects']) await conn(t).delete();
    for (const root of ['quotes', 'contracts', 'invoices']) await conn(root).insert([
      { id: 1, created_by_admin_id: 10, deal_uuid: 'own', status: 'draft' },
      { id: 2, created_by_admin_id: 20, deal_uuid: 'foreign', status: 'draft' },
      { id: 3, created_by_admin_id: null, deal_uuid: 'orphan', status: 'draft' },
    ]);
    await conn('projects').insert([{ id: 1, created_by: 10 }, { id: 2, created_by: 20 }, { id: 3, created_by: null }]);
    await conn('events').insert([{ id: 1, created_by: 10, project_id: 1 }, { id: 2, created_by: 20, project_id: 2 }, { id: 3, created_by: null, project_id: 3 }]);
    await conn('quote_line_items').insert([{ id: 1, quote_id: 1, description: 'own' }, { id: 2, quote_id: 2, description: 'foreign' }]);
    await conn('invoice_payment_log').insert([{ id: 1, invoice_id: 1, amount_minor: 10 }, { id: 2, invoice_id: 2, amount_minor: 20 }]);
    await conn('contract_signers').insert([{ id: 1, contract_id: 1 }, { id: 2, contract_id: 2 }]);
    await conn('contract_signing_sessions').insert([{ id: 1, signer_id: 1, token: 'own' }, { id: 2, signer_id: 2, token: 'foreign' }]);
    await conn('generated_documents').insert([{ id: 1, doc_type: 'contract', doc_id: 1, path: 'own.pdf' }, { id: 2, doc_type: 'contract', doc_id: 2, path: 'foreign.pdf' }]);
    await conn('accounting_change_history').insert([{ id: 1, document_type: 'invoice', document_id: 1 }, { id: 2, document_type: 'invoice', document_id: 2 }]);
    await conn('customer_documents').insert([{ id: 1, contract_id: 1 }, { id: 2, contract_id: 2 }]);
  }));

  afterAll(async () => {
    if (conn) {
      if (client === 'pg') await trusted(() => conn.schema.dropSchemaIfExists(schema, true));
      await conn.destroy();
    }
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  test.each(['quotes', 'contracts', 'invoices'])('filters %s lists, detail and counts by live actor', async root => {
    await as(actor(10), async () => {
      expect((await conn(root).orderBy('id')).map(r => r.id)).toEqual([1]);
      expect(await conn(root).where('id', 2).first()).toBeUndefined();
      expect(Number((await conn(root).count({ count: '*' }).first()).count)).toBe(1);
    });
    expect((await as(actor(20), () => conn(root))).map(r => r.id)).toEqual([2]);
  });

  test('cannot remove scope with OR, clearWhere, clone, from, aliases, subqueries or union', () => as(actor(10), async () => {
    const queries = [conn('quotes').where('id', 1).orWhere('id', 2), conn('quotes').where('id', 2).clearWhere(),
      conn('quotes').where('id', 2).clone().orWhereRaw('1 = 1'), conn.queryBuilder().from({ q: 'quotes' }),
      conn('quotes as q').whereRaw('1 = 1'), conn.select('*').from(conn('quotes').select('*').as('q')),
      conn('quotes').select('id').union(conn('quotes').select('id').where('id', 2))];
    for (const query of queries) expect((await query).map(r => r.id)).toEqual([1]);
  }));

  test('protects joins without discarding an unrelated left-hand accounting row', () => as(actor(10), async () => {
    const rows = await conn('projects as p').leftJoin('contracts as c', 'c.id', 'p.id').select('p.id', 'c.id as contract_id').orderBy('p.id');
    expect(rows).toEqual([{ id: 1, contract_id: 1 }, { id: 2, contract_id: null }, { id: 3, contract_id: null }]);
  }));

  test.each(['quote_line_items', 'invoice_payment_log', 'contract_signers', 'contract_signing_sessions',
    'generated_documents', 'accounting_change_history', 'customer_documents'])('scopes %s through its document', async table => {
    expect((await as(actor(10), () => conn(table))).map(r => r.id)).toEqual([1]);
  });

  test('domain permissions are required, and view-only cannot mutate even its own record', async () => {
    expect(await as(actor(10, []), () => conn('quotes'))).toEqual([]);
    await expect(as(actor(10, ['quotes.view']), () => conn('quotes').where('id', 1).update({ status: 'sent' }))).rejects.toMatchObject({ statusCode: 403 });
    await expect(as(actor(10, ['quotes.view']), () => conn('quote_line_items').insert({ quote_id: 1 }))).rejects.toMatchObject({ statusCode: 403 });
    await expect(as(actor(10, ['contracts.view']), () => conn('customer_documents').insert({ contract_id: 1 }))).rejects.toMatchObject({ statusCode: 403 });
    expect((await as(actor(10, ['quotes.view']), () => conn('quotes'))).map(r => r.id)).toEqual([1]);
  });

  test('an owned project or event does not override another stored creator', async () => {
    await trusted(() => conn('quotes').where('id', 2).update({ project_id: 1, converted_event_id: 1 }));
    expect(await as(actor(10), () => conn('quotes').where('id', 2).first())).toBeUndefined();
  });

  test('creatorless fallback needs agreeing owned anchors; an ownerless event is not a grant', async () => {
    await trusted(() => conn('quotes').insert([
      { id: 4, project_id: 1 }, { id: 5, converted_event_id: 1 }, { id: 6, project_id: 1, converted_event_id: 2 },
      { id: 7, converted_event_id: 3 }, { id: 8, deal_uuid: 'own' },
    ]));
    expect((await as(actor(10), () => conn('quotes').orderBy('id'))).map(r => r.id)).toEqual([1, 4, 5, 8]);
    await trusted(() => conn('contracts').insert({ id: 9, created_by_admin_id: 20, deal_uuid: 'own' }));
    expect(await as(actor(10), () => conn('quotes').where('id', 8).first())).toBeUndefined();
  });

  test('super-admin and explicit system operations preserve legacy-ownerless access', async () => {
    expect((await as(actor(99, [], 'super_admin'), () => conn('quotes'))).length).toBe(3);
    expect((await trusted(() => conn('quotes'))).length).toBe(3);
    await expect(withoutCrmContext(() => conn('quotes').select())).rejects.toMatchObject({ statusCode: 403 });
  });

  test('legacy quote-to-contract-to-invoice ownership is finite and conflicting anchors deny it', async () => {
    await trusted(async () => {
      await conn('contracts').insert({ id: 5, source_quote_id: 1 });
      await conn('invoices').insert({ id: 5, source_contract_id: 5 });
    });
    expect(await as(actor(10), () => conn('invoices').where('id', 5).first())).toBeDefined();
    await trusted(() => conn('contracts').where('id', 5).update({ project_id: 2 }));
    expect(await as(actor(10), () => conn('invoices').where('id', 5).first())).toBeUndefined();
  });

  test('all transaction forms retain scope, including nested savepoints and .transacting()', () => as(actor(10), async () => {
    await conn.transaction(async trx => {
      expect(await trx('quotes').where('id', 2).update({ status: 'sent' })).toBe(0);
      expect(await conn('quotes').transacting(trx).where('id', 2).delete()).toBe(0);
      await trx.transaction(async nested => expect((await nested('quotes')).map(r => r.id)).toEqual([1]));
    });
    expect((await conn('quotes')).map(r => r.id)).toEqual([1]);
  }));

  test('creator spoofing, foreign child inserts, parent rewrites and foreign lineage are denied atomically', () => as(actor(10), async () => {
    await expect(conn('quotes').insert({ created_by_admin_id: 20 })).rejects.toMatchObject({ statusCode: 403 });
    await expect(conn('quotes').where('id', 1).update({ created_by_admin_id: 20 })).rejects.toMatchObject({ statusCode: 403 });
    await expect(conn('quotes').where('id', 1).update({ id: 20 })).rejects.toMatchObject({ statusCode: 403 });
    await expect(conn('quote_line_items').where('id', 1).increment('quote_id', 1)).rejects.toMatchObject({ statusCode: 403 });
    await expect(conn('quote_line_items').insert({ quote_id: 2 })).rejects.toMatchObject({ statusCode: 404 });
    await expect(conn('quote_line_items').where('id', 1).update({ quote_id: 2 })).rejects.toMatchObject({ statusCode: 404 });
    await expect(conn('quotes').where('id', 1).update({ project_id: 2 })).rejects.toMatchObject({ statusCode: 404 });
    await expect(conn('quotes').where('id', 1).update({ deal_uuid: 'foreign' })).rejects.toMatchObject({ statusCode: 404 });
    await expect(conn.transaction(async trx => {
      await trx('quotes').where('id', 1).update({ status: 'sent' });
      await trx('quote_line_items').insert({ quote_id: 2 });
    })).rejects.toMatchObject({ statusCode: 404 });
    expect((await conn('quotes').where('id', 1).first()).status).toBe('draft');
    await conn('quote_line_items').insert({ id: 20, quote_id: 1, description: 'legitimate' });
    expect((await conn('quote_line_items')).length).toBe(2);
  }));

  test('parent deletes cannot indirectly rewrite foreign CRM records through FK actions', async () => {
    await trusted(() => conn('quotes').where('id', 2).update({ converted_event_id: 1 }));
    await expect(as(actor(10), () => conn('events').where('id', 1).delete())).rejects.toMatchObject({ statusCode: 403 });
    expect(await conn('events').where('id', 1).first()).toBeDefined();
    await trusted(() => conn('quotes').where('id', 2).update({ converted_event_id: null }));
    expect(await as(actor(10), () => conn('events').where('id', 1).delete())).toBe(1);
    await trusted(() => conn('invoices').where('id', 2).update({ cancellation_storno_id: 1 }));
    await expect(as(actor(10), () => conn('invoices').where('id', 1).delete())).rejects.toMatchObject({ statusCode: 403 });
    await expect(as(actor(10), () => conn('invoices').where('id', 1)
      .update({ cancellation_storno_id: 2 }))).rejects.toMatchObject({ statusCode: 404 });
  });

  test('direct raw/from-raw CRM access cannot bypass the shared policy', () => as(actor(10), async () => {
    await expect(conn.raw('select * from quotes')).rejects.toMatchObject({ statusCode: 403 });
    await expect(conn('quotes').truncate()).rejects.toMatchObject({ statusCode: 403 });
    await expect(conn.raw('delete from events')).rejects.toMatchObject({ statusCode: 403 });
    await expect(conn('events').truncate()).rejects.toMatchObject({ statusCode: 403 });
    await expect(conn.queryBuilder().from(conn.raw('events')).delete()).rejects.toMatchObject({ statusCode: 403 });
    await expect(conn(client === 'pg' ? `${schema}.events` : 'main.events').delete()).rejects.toMatchObject({ statusCode: 403 });
    await expect(conn.select('*').from(conn.raw('quotes'))).rejects.toMatchObject({ statusCode: 403 });
    await expect(conn.raw('select * from ??', ['quotes'])).rejects.toMatchObject({ statusCode: 403 });
    await expect(conn.select('*').from(conn.raw('??', ['quotes']))).rejects.toMatchObject({ statusCode: 403 });
    await expect(conn('projects').select(conn.raw('(select status from quotes where id = 2) as secret'))).rejects.toMatchObject({ statusCode: 403 });
    await expect(conn(client === 'pg' ? `${schema}.quotes` : 'main.quotes').select()).rejects.toMatchObject({ statusCode: 403 });
    expect(() => conn('quotes').insert({ created_by_admin_id: 20 }).stream()).toThrow('Streaming CRM mutations');
  }));

  test('a workflow entity capability cannot reach another same-owner deal or accept payload redirects', () => as({ ...actor(10),
    capability: { root: 'quotes', id: 1, dealUuid: 'own', eventId: null } }, async () => {
    await trusted(() => conn('invoices').insert({ id: 4, created_by_admin_id: 10, deal_uuid: 'different-own-deal' }));
    expect((await conn('invoices')).map(r => r.id)).toEqual([1]);
    expect(await conn('invoices').where('id', 4).update({ status: 'sent' })).toBe(0);
    await expect(conn('invoices').insert({ id: 5, created_by_admin_id: 10, deal_uuid: 'different-own-deal' })).rejects.toMatchObject({ statusCode: 403 });
    await conn('invoices').insert({ id: 5, created_by_admin_id: 10, deal_uuid: 'own' });
    expect((await conn('invoices').orderBy('id')).map(r => r.id)).toEqual([1, 5]);
  }));

  (client === 'pg' ? test : test.skip).each(['insert', 'update', 'delete'])('derived owners stay fenced until a %s transaction commits', async operation => {
    await trusted(() => conn('quotes').insert({ id: 4, project_id: 1 }));
    let competing, completed = false;
    await as(actor(10), () => conn.transaction(async trx => {
      if (operation === 'insert') await trx('quote_line_items').insert({ id: 21, quote_id: 4 });
      else if (operation === 'update') await trx('quotes').where('id', 4).update({ status: 'sent' });
      else await trx('quotes').where('id', 4).delete();
      let submitted;
      const submission = new Promise(resolve => { submitted = resolve; });
      const observe = query => { if (/update "projects"/.test(query.sql)) submitted(); };
      conn.on('query', observe);
      competing = trusted(() => conn('projects').where('id', 1).update({ created_by: 20 }).timeout(3000))
        .then(() => { completed = true; });
      await submission;
      await new Promise(resolve => setTimeout(resolve, 30));
      expect(completed).toBe(false);
      conn.off('query', observe);
    }));
    await competing;
    expect(completed).toBe(true);
    expect(await as(actor(10), () => conn('quote_line_items').where('id', 21).first())).toBeUndefined();
  });

  (client === 'pg' ? test : test.skip)('ordinary concurrent owner writes serialize without shared-lock upgrade deadlocks', async () => {
    const results = await Promise.all(['sent', 'draft'].map(status => as(actor(10), () => conn('quotes').where('id', 1).update({ status }).timeout(3000))));
    expect(results).toEqual([1, 1]);
  });
});
