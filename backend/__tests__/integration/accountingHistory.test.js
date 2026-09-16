/**
 * Accounting change history recorder (migration 219).
 *
 * The recorder is the only way audited tables are written
 * (accountingHistoryCoverage.test.js). These tests pin its contract: history
 * rows carry the changed values and the actor, bookkeeping-only changes leave
 * no row, compare-and-set updates keep knex's row count, and a history row
 * that cannot be written rolls the business change back, with or without the
 * caller's transaction.
 */
const request = require('supertest');
const {
  bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken, buildRouteApp,
} = require('./helpers/crmDb');

jest.setTimeout(120000);

let db; let cleanup; let adminId; let customerId; let history; let invoiceApp;
let invoiceSeq = 0;
const DEAL = '6f1c2b1e-3d4a-4c5b-8e9f-0a1b2c3d4e5f';

const invoiceValues = (extra = {}) => {
  invoiceSeq += 1;
  return {
    invoice_number: `H-${invoiceSeq}`,
    customer_account_id: customerId,
    kind: 'invoice',
    status: 'draft',
    currency: 'CHF',
    issue_date: '2026-09-16',
    due_date: '2026-10-16',
    net_amount_minor: 10000,
    vat_rate: 0,
    vat_amount_minor: 0,
    total_amount_minor: 10000,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...extra,
  };
};

const historyOf = (type, id) => history.listHistory(type, id);

async function withHistoryTableOffline(work) {
  await db.schema.renameTable('accounting_change_history', 'accounting_change_history_offline');
  try {
    return await work();
  } finally {
    await db.schema.renameTable('accounting_change_history_offline', 'accounting_change_history');
  }
}

beforeAll(async () => {
  ({ db, cleanup } = await bootCrmDb());
  ({ adminId, customerId } = await seedMinimal(db));
  history = require('../../src/services/accountingHistory');
  const updated = await db('feature_flags').where({ key: 'bills' }).update({ value: true });
  if (!updated) await db('feature_flags').insert({ key: 'bills', value: true });
  invoiceApp = buildRouteApp('/api/admin/invoices', require('../../src/routes/adminInvoices'));
});

afterAll(async () => { if (cleanup) await cleanup(); });

describe('auditedInsert', () => {
  it('records the created row\'s values, its document and the actor', async () => {
    const [{ id }] = await history.auditedInsert(db, 'invoices', invoiceValues(), {
      actor: `admin:${adminId}`, source: 'test.create',
    });
    const [lineItem] = await history.auditedInsert(db, 'invoice_line_items', {
      invoice_id: id, position: 1, quantity: 1, description: 'Coverage',
      unit_price_minor: 10000, discount_percent: 0, line_total_minor: 10000,
    }, { actor: adminId });

    const entries = await historyOf('invoice', id);
    expect(entries.map((e) => [e.entity_type, e.action])).toEqual([
      ['invoice', 'created'], ['invoice_line_item', 'created'],
    ]);
    expect(entries[0]).toMatchObject({
      entity_id: id,
      actor: { type: 'admin', id: adminId },
      source: 'test.create',
    });
    expect(entries[0].changes.total_amount_minor).toEqual({ from: null, to: 10000 });
    expect(entries[0].changes).not.toHaveProperty('updated_at');
    expect(entries[1]).toMatchObject({ entity_id: lineItem.id });
    expect(entries[1].changes.description).toEqual({ from: null, to: 'Coverage' });
  });
});

describe('auditedUpdate', () => {
  it('records only the columns that changed, and nothing for bookkeeping-only updates', async () => {
    const [{ id }] = await history.auditedInsert(db, 'invoices', invoiceValues(), { actor: adminId });
    expect(await history.auditedUpdate(db, 'invoices', { id }, {
      status: 'sent', updated_at: new Date().toISOString(),
    }, { actor: { type: 'admin', id: adminId, name: 'tester' }, source: 'invoice.send' })).toBe(1);
    expect(await history.auditedUpdate(db, 'invoices', { id }, {
      updated_at: new Date(Date.now() + 1000).toISOString(),
    }, { actor: adminId })).toBe(1);

    const updates = (await historyOf('invoice', id)).filter((e) => e.action === 'updated');
    expect(updates).toHaveLength(1);
    expect(updates[0].changes).toEqual({ status: { from: 'draft', to: 'sent' } });
    expect(updates[0].actor).toEqual({ type: 'admin', id: adminId, name: 'tester' });
  });

  it('keeps compare-and-set semantics: no match, no write, no history', async () => {
    const [{ id }] = await history.auditedInsert(db, 'invoices', invoiceValues(), { actor: adminId });
    const count = await history.auditedUpdate(db, 'invoices', (q) => q.where({ id, status: 'paid' }), {
      status: 'cancelled',
    }, { actor: adminId });
    expect(count).toBe(0);
    expect((await db('invoices').where({ id }).first()).status).toBe('draft');
    expect((await historyOf('invoice', id)).filter((e) => e.action === 'updated')).toHaveLength(0);
  });

  it('records one entry per row for multi-row updates', async () => {
    const [{ id: a }] = await history.auditedInsert(db, 'invoices', invoiceValues({ deal_uuid: DEAL }), {});
    const [{ id: b }] = await history.auditedInsert(db, 'invoices', invoiceValues({ deal_uuid: DEAL }), {});
    expect(await history.auditedUpdate(db, 'invoices', { deal_uuid: DEAL }, { vat_code: 'X' }, { actor: 'scheduler' })).toBe(2);
    for (const id of [a, b]) {
      const [update] = (await historyOf('invoice', id)).filter((e) => e.action === 'updated');
      expect(update.changes).toEqual({ vat_code: { from: null, to: 'X' } });
      expect(update.actor).toEqual({ type: 'system', id: null, name: 'scheduler' });
    }
  });
});

describe('auditedDelete', () => {
  it('records what the deleted row held', async () => {
    const [{ id }] = await history.auditedInsert(db, 'invoices', invoiceValues(), { actor: adminId });
    const [item] = await history.auditedInsert(db, 'invoice_line_items', {
      invoice_id: id, position: 1, quantity: 2, description: 'Prints',
      unit_price_minor: 500, discount_percent: 0, line_total_minor: 1000,
    }, { actor: adminId });
    expect(await history.auditedDelete(db, 'invoice_line_items', { invoice_id: id }, { actor: adminId })).toBe(1);
    const deleted = (await historyOf('invoice', id)).find((e) => e.action === 'deleted');
    expect(deleted).toMatchObject({ entity_type: 'invoice_line_item', entity_id: item.id });
    expect(deleted.changes.description).toEqual({ from: 'Prints', to: null });
  });
});

describe('a history row that cannot be written', () => {
  it.each(['insert', 'update', 'delete'])('rolls back %s even when the caller catches the error', async (operation) => {
    const [{ id }] = await history.auditedInsert(db, 'invoices', invoiceValues(), { actor: adminId });
    const values = invoiceValues();
    await withHistoryTableOffline(async () => {
      await db.transaction(async (trx) => {
        const write = operation === 'insert'
          ? () => history.auditedInsert(trx, 'invoices', values)
          : operation === 'update'
            ? () => history.auditedUpdate(trx, 'invoices', { id }, { status: 'paid' })
            : () => history.auditedDelete(trx, 'invoices', { id });
        await expect(write()).rejects.toThrow();
        // The caller can continue and commit unrelated work after rollback
        // to the recorder's savepoint, including on PostgreSQL.
        await trx('app_settings').insert({ setting_key: `history_caught_${operation}`, setting_value: JSON.stringify('ok') });
      });
    });
    expect((await db('invoices').where({ id }).first()).status).toBe('draft');
    expect(await db('invoices').where({ invoice_number: values.invoice_number }).first()).toBeUndefined();
    expect((await historyOf('invoice', id)).map((e) => e.action)).toEqual(['created']);
    expect(await db('app_settings').where({ setting_key: `history_caught_${operation}` }).first()).toBeTruthy();
  });

  it('rolls back a standalone write', async () => {
    const [{ id }] = await history.auditedInsert(db, 'invoices', invoiceValues(), { actor: adminId });
    await withHistoryTableOffline(() => expect(
      history.auditedUpdate(db, 'invoices', { id }, { status: 'sent' }, { actor: adminId }),
    ).rejects.toThrow());
    expect((await db('invoices').where({ id }).first()).status).toBe('draft');

    const before = (await db('invoices').count('* as n'))[0].n;
    await withHistoryTableOffline(() => expect(
      history.auditedInsert(db, 'invoices', invoiceValues(), { actor: adminId }),
    ).rejects.toThrow());
    expect((await db('invoices').count('* as n'))[0].n).toBe(before);
  });

  it('fails the caller\'s transaction', async () => {
    const [{ id }] = await history.auditedInsert(db, 'invoices', invoiceValues(), { actor: adminId });
    await withHistoryTableOffline(() => expect(db.transaction(async (trx) => {
      await trx('invoices').where({ id }).first();
      await history.auditedDelete(trx, 'invoices', { id }, { actor: adminId });
    })).rejects.toThrow());
    expect(await db('invoices').where({ id }).first()).toBeTruthy();
  });
});

describe('concurrent payments', () => {
  it('keeps both payments and the full running total', async () => {
    const [{ id }] = await history.auditedInsert(db, 'invoices', invoiceValues({ status: 'sent' }));
    const { markPaid } = require('../../src/services/invoice/payments');
    await Promise.all([4000, 6000].map((amountMinor) => markPaid(id, { amountMinor }, adminId)));
    expect(await db('invoice_payment_log').where({ invoice_id: id })).toHaveLength(2);
    const invoice = await db('invoices').where({ id }).first();
    expect(Number(invoice.paid_amount_minor)).toBe(10000);
    expect(invoice.status).toBe('paid');
    const entries = await historyOf('invoice', id);
    expect(entries.filter((e) => e.entity_type === 'invoice_payment')).toHaveLength(2);
    expect(Number(entries.filter((e) => e.changes.paid_amount_minor).at(-1).changes.paid_amount_minor.to)).toBe(10000);
  });

  const pgOnly = process.env.DATABASE_CLIENT === 'pg' ? it : it.skip;
  pgOnly('does not upgrade two child FK locks into a parent-row deadlock', async () => {
    const [{ id }] = await history.auditedInsert(db, 'invoices', invoiceValues());
    let arrived = 0;
    let release;
    const bothInserted = new Promise((resolve) => { release = resolve; });
    const payment = () => db.transaction(async (trx) => {
      await history.auditedInsert(trx, 'invoice_payment_log', { invoice_id: id, amount_minor: 100, paid_at: new Date() });
      if (++arrived === 2) release();
      await bothInserted;
      await history.auditedUpdate(trx, 'invoices', { id }, {
        paid_amount_minor: trx.raw('?? + ?', ['paid_amount_minor', 100]),
      });
    });
    await Promise.all([payment(), payment()]);
    expect(Number((await db('invoices').where({ id }).first()).paid_amount_minor)).toBe(200);
  });
});

describe('normalizeActor', () => {
  it.each([
    [null, { type: 'system', id: null, name: null }],
    [7, { type: 'admin', id: 7, name: null }],
    ['admin:7', { type: 'admin', id: 7, name: null }],
    ['customer:public', { type: 'customer', id: null, name: 'public' }],
    ['public:payment-check', { type: 'public', id: null, name: 'payment-check' }],
    ['scheduler', { type: 'system', id: null, name: 'scheduler' }],
    [{ type: 'customer', id: '12', name: 'Custo Mer' }, { type: 'customer', id: 12, name: 'Custo Mer' }],
    [{ type: 'bogus', id: 'x' }, { type: 'system', id: null, name: null }],
  ])('%p', (input, expected) => {
    expect(history.normalizeActor(input)).toEqual(expected);
  });
});

describe('GET /api/admin/invoices/:id/history', () => {
  it('requires bills.view and returns the entries oldest first', async () => {
    const [{ id }] = await history.auditedInsert(db, 'invoices', invoiceValues(), { actor: adminId });
    await history.auditedUpdate(db, 'invoices', { id }, { status: 'sent' }, { actor: adminId });

    const denied = await request(invoiceApp)
      .get(`/api/admin/invoices/${id}/history`)
      .set('Authorization', `Bearer ${mintAdminToken(adminId)}`);
    expect(denied.status).toBe(403);

    await assignAdminRole(db, adminId);
    const res = await request(invoiceApp)
      .get(`/api/admin/invoices/${id}/history`)
      .set('Authorization', `Bearer ${mintAdminToken(adminId)}`);
    expect(res.status).toBe(200);
    const entries = res.body.entries ?? res.body.data?.entries;
    expect(entries.map((e) => e.action)).toEqual(['created', 'updated']);
    expect(entries[1].changes).toEqual({ status: { from: 'draft', to: 'sent' } });
  });
});
