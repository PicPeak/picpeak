/**
 * Invoice flows record the accounting change history (migration 219).
 *
 * Drives the real invoice routes and services (create, edit, send, pay,
 * Storno, reissue, reminder, installment reshape, payment-check link) and
 * pins the history rows each one leaves: action, entity, the changed columns
 * and who made the change. A history row that cannot be written must take the
 * business change down with it.
 */
const request = require('supertest');
const {
  bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken, buildRouteApp,
} = require('./helpers/crmDb');

jest.setTimeout(120000);

let db; let cleanup; let tmpDir; let adminId; let customerId; let token;
let invoiceApp; let invoiceService; let history;
const prevCwd = process.cwd();

const auth = () => ({ Authorization: `Bearer ${token}` });

// PostgreSQL returns bigint ids as strings; compare ids as numbers.
const entriesOf = async (invoiceId) => (await history.listHistory('invoice', invoiceId)).map((e) => ({
  ...e,
  entity_id: Number(e.entity_id),
  actor: { ...e.actor, id: e.actor.id == null ? null : Number(e.actor.id) },
}));
const bySource = (entries, source) => entries.filter((e) => e.source === source);
const adminActor = () => ({ type: 'admin', id: Number(adminId), name: null });

async function withHistoryTableOffline(work) {
  await db.schema.renameTable('accounting_change_history', 'accounting_change_history_offline');
  try {
    return await work();
  } finally {
    await db.schema.renameTable('accounting_change_history_offline', 'accounting_change_history');
  }
}

async function createViaRoute(body = {}) {
  const res = await request(invoiceApp).post('/api/admin/invoices').set(auth()).send({
    customerAccountId: customerId,
    currency: 'CHF',
    lineItems: [
      { position: 1, quantity: 1, description: 'Wedding coverage', unitPriceMinor: 200000, discountPercent: 0 },
      { position: 2, quantity: 2, description: 'Prints', unitPriceMinor: 5000, discountPercent: 0 },
    ],
    ...body,
  });
  expect(res.status).toBe(201);
  return res.body.invoiceIds.map(Number);
}

async function sentInvoice() {
  const [id] = await createViaRoute();
  await request(invoiceApp).post(`/api/admin/invoices/${id}/send`).set(auth()).send({}).expect(200);
  return id;
}

beforeAll(async () => {
  ({ db, cleanup, tmpDir } = await bootCrmDb());
  process.chdir(tmpDir);

  // Same Date-binding normalisation as crmMintPaths.test.js: under jest's vm
  // sandbox node-sqlite3 stores service-created Dates as "[object Object]".
  const clientProto = Object.getPrototypeOf(db.client);
  const origQuery = clientProto._query;
  clientProto._query = function patchedQuery(connection, obj) {
    if (obj && Array.isArray(obj.bindings)) {
      obj.bindings = obj.bindings.map(
        (b) => (b && typeof b === 'object' && typeof b.toISOString === 'function' ? b.toISOString() : b),
      );
    }
    return origQuery.call(this, connection, obj);
  };

  // updateInstallmentPlan calls logActivity through the global db while its
  // transaction holds SQLite's only connection; that audit insert waits out
  // the acquire timeout and is swallowed. Keep the wait short here.
  db.client.pool.acquireTimeoutMillis = 2000;

  ({ adminId, customerId } = await seedMinimal(db));
  await assignAdminRole(db, adminId, 'super_admin');
  token = mintAdminToken(adminId);
  const updated = await db('feature_flags').where({ key: 'bills' }).update({ value: true });
  if (!updated) await db('feature_flags').insert({ key: 'bills', value: true });

  history = require('../../src/services/accountingHistory');
  invoiceService = require('../../src/services/invoiceService');
  invoiceApp = buildRouteApp('/api/admin/invoices', require('../../src/routes/adminInvoices'));
}, 120000);

afterAll(async () => {
  process.chdir(prevCwd);
  if (cleanup) await cleanup();
});

describe('create and edit', () => {
  it('POST / records the created invoice with its totals and the admin', async () => {
    const [id] = await createViaRoute();
    const [created] = (await entriesOf(id)).filter((e) => e.entity_type === 'invoice');
    expect(created).toMatchObject({
      action: 'created', entity_id: id, actor: adminActor(), source: 'invoice.create',
    });
    expect(created.changes.status).toEqual({ from: null, to: 'scheduled' });
    expect(created.changes.net_amount_minor).toEqual({ from: null, to: 210000 });
  });

  it('PUT /:id with line items records the replaced items and the new totals', async () => {
    const [id] = await createViaRoute();
    const oldItemIds = (await db('invoice_line_items').where({ invoice_id: id })).map((li) => Number(li.id));

    const res = await request(invoiceApp).put(`/api/admin/invoices/${id}`).set(auth()).send({
      lineItems: [{ position: 1, quantity: 1, description: 'Elopement', unitPriceMinor: 90000, discountPercent: 0 }],
    });
    expect(res.status).toBe(200);

    const update = bySource(await entriesOf(id), 'invoice.update');
    const deleted = update.filter((e) => e.entity_type === 'invoice_line_item' && e.action === 'deleted');
    expect(deleted.map((e) => e.entity_id).sort()).toEqual(oldItemIds.sort());
    expect(deleted.every((e) => e.actor.id === Number(adminId))).toBe(true);
    expect(deleted.find((e) => e.changes.description?.from === 'Prints')).toBeTruthy();

    const [invoiceUpdate] = update.filter((e) => e.entity_type === 'invoice');
    expect(invoiceUpdate).toMatchObject({ action: 'updated', actor: adminActor() });
    expect(invoiceUpdate.changes.net_amount_minor).toEqual({ from: 210000, to: 90000 });
  });
});

describe('send, pay, remind', () => {
  it('POST /:id/send records scheduled → sent', async () => {
    const id = await sentInvoice();
    const [send] = bySource(await entriesOf(id), 'invoice.send');
    expect(send).toMatchObject({ action: 'updated', entity_type: 'invoice', actor: adminActor() });
    expect(send.changes.status).toEqual({ from: 'scheduled', to: 'sent' });
    expect(send.changes.pdf_path.to).toBeTruthy();
  });

  it('POST /:id/mark-paid records the payment row and the invoice update', async () => {
    const id = await sentInvoice();
    const invoice = await db('invoices').where({ id }).first();
    const total = Number(invoice.total_amount_minor);
    await request(invoiceApp).post(`/api/admin/invoices/${id}/mark-paid`).set(auth())
      .send({ amountMinor: total, paymentMethod: 'bank_transfer' }).expect(200);

    const paid = bySource(await entriesOf(id), 'invoice.markPaid');
    const payment = paid.find((e) => e.entity_type === 'invoice_payment');
    expect(payment).toMatchObject({ action: 'created', actor: adminActor() });
    expect(payment.changes.amount_minor).toEqual({ from: null, to: total });
    const update = paid.find((e) => e.entity_type === 'invoice');
    expect(update.changes.status).toEqual({ from: 'sent', to: 'paid' });
    expect(update.changes.paid_amount_minor).toEqual({ from: 0, to: total });
  });

  it('POST /:id/send-reminder records the dunning state change', async () => {
    const id = await sentInvoice();
    await request(invoiceApp).post(`/api/admin/invoices/${id}/send-reminder`).set(auth()).send({}).expect(200);
    const [reminder] = bySource(await entriesOf(id), 'invoice.reminder');
    expect(reminder).toMatchObject({ action: 'updated', actor: adminActor() });
    expect(reminder.changes.status).toEqual({ from: 'sent', to: 'overdue' });
    expect(reminder.changes.reminder_level).toEqual({ from: 0, to: 1 });
  });

  it('the payment-check link records the payment as the public link, not an admin', async () => {
    const id = await sentInvoice();
    const { token: checkToken, sent } = await invoiceService.queuePaymentCheckEmail(id, { skipThrottle: true });
    expect(sent).toBe(true);
    const [queued] = bySource(await entriesOf(id), 'invoice.paymentCheck.queue');
    expect(queued.changes.last_payment_check_at.from).toBeNull();

    await invoiceService.recordPaymentCheckAction({ token: checkToken, action: 'paid_full', ip: '127.0.0.1' });
    const paid = bySource(await entriesOf(id), 'invoice.markPaid');
    expect(paid.map((e) => e.entity_type).sort()).toEqual(['invoice', 'invoice_payment']);
    for (const entry of paid) {
      expect(entry.actor).toEqual({ type: 'public', id: null, name: 'payment-check' });
    }
    // recorded_by_admin_id keeps naming the invoice's admin, as before.
    const [log] = await db('invoice_payment_log').where({ invoice_id: id });
    expect(Number(log.recorded_by_admin_id)).toBe(Number(adminId));
  });
});

describe('Storno and reissue', () => {
  it('POST /:id/cancel records the Storno and the cancelled original', async () => {
    const id = await sentInvoice();
    const res = await request(invoiceApp).post(`/api/admin/invoices/${id}/cancel`).set(auth()).send({});
    expect(res.status).toBe(200);
    const stornoId = Number(res.body.stornoId);

    const [cancel] = bySource(await entriesOf(id), 'invoice.storno.cancelOriginal');
    expect(cancel).toMatchObject({ action: 'updated', actor: adminActor() });
    expect(cancel.changes.status).toEqual({ from: 'sent', to: 'cancelled' });
    expect(cancel.changes.cancellation_storno_id).toEqual({ from: null, to: stornoId });

    const stornoEntries = await entriesOf(stornoId);
    const [created] = bySource(stornoEntries, 'invoice.storno.create').filter((e) => e.entity_type === 'invoice');
    expect(created).toMatchObject({ action: 'created', actor: adminActor() });
    expect(created.changes.kind).toEqual({ from: null, to: 'storno' });
    expect(created.changes.cancels_invoice_id).toEqual({ from: null, to: id });
    const [sentStorno] = bySource(stornoEntries, 'invoice.storno.send');
    expect(sentStorno.changes.status).toEqual({ from: 'scheduled', to: 'sent' });
  });

  it('POST /:id/reissue records the replacement and its lineage', async () => {
    const id = await sentInvoice();
    const res = await request(invoiceApp).post(`/api/admin/invoices/${id}/reissue`).set(auth()).send({});
    expect(res.status).toBe(201);
    const newId = Number(res.body.id);

    expect(bySource(await entriesOf(id), 'invoice.storno.cancelOriginal')).toHaveLength(1);
    const entries = await entriesOf(newId);
    expect(bySource(entries, 'invoice.create').find((e) => e.entity_type === 'invoice').action).toBe('created');
    const [lineage] = bySource(entries, 'invoice.reissue');
    expect(lineage).toMatchObject({ action: 'updated', actor: adminActor() });
    expect(lineage.changes.replaces_invoice_id).toEqual({ from: null, to: id });
  });
});

describe('installment plan', () => {
  it('reshaping 2 → 1 records the kept sibling, its reconciliation line and the trimmed sibling', async () => {
    const [first, second] = await createViaRoute({
      installments: [
        { label: 'Anzahlung', percent: 50, trigger: 'quote_accepted', offset_days: 0 },
        { label: 'Rest', percent: 50, trigger: 'after_event', offset_days: 7 },
      ],
    });
    const spawned = bySource(await entriesOf(first), 'invoice.spawnInstallments');
    expect(spawned.map((e) => [e.entity_type, e.action])).toEqual(expect.arrayContaining([
      ['invoice', 'created'], ['invoice_line_item', 'created'],
    ]));
    const reconId = spawned.find((e) => e.entity_type === 'invoice_line_item').entity_id;
    const secondItemIds = (await db('invoice_line_items').where({ invoice_id: second })).map((li) => Number(li.id));
    const { deal_uuid: dealUuid } = await db('invoices').where({ id: first }).first();

    const result = await db.transaction((trx) => invoiceService.updateInstallmentPlan({
      trx, dealUuid, adminId,
      installments: [{ label: 'Gesamt', percent: 100, trigger: 'quote_accepted', offset_days: 0 }],
    }));
    expect(result.deleted.map(Number)).toEqual([second]);

    const kept = await entriesOf(first);
    const [update] = bySource(kept, 'invoice.installmentPlan.update');
    expect(update).toMatchObject({ action: 'updated', actor: adminActor() });
    expect(update.changes.installment_total).toEqual({ from: 2, to: 1 });
    expect(update.changes.net_amount_minor).toEqual({ from: 105000, to: 210000 });
    const [reconDeleted] = bySource(kept, 'invoice.installmentPlan.reconciliationLine');
    expect(reconDeleted).toMatchObject({ action: 'deleted', entity_id: reconId, actor: adminActor() });

    const trimmed = bySource(await entriesOf(second), 'invoice.installmentPlan.trim');
    expect(trimmed.filter((e) => e.entity_type === 'invoice_line_item').map((e) => e.entity_id).sort())
      .toEqual(secondItemIds.sort());
    const invoiceDeleted = trimmed.find((e) => e.entity_type === 'invoice');
    expect(invoiceDeleted).toMatchObject({ action: 'deleted', entity_id: second, actor: adminActor() });
    expect(invoiceDeleted.changes.status).toEqual({ from: 'scheduled', to: null });
    expect(await db('invoices').where({ id: second }).first()).toBeUndefined();
  });
});

describe('a history row that cannot be written', () => {
  it('rolls back the whole payment: no payment row, invoice untouched', async () => {
    const id = await sentInvoice();
    const before = await db('invoices').where({ id }).first();
    await withHistoryTableOffline(() => expect(
      invoiceService.markPaid(id, { amountMinor: 1000 }, adminId),
    ).rejects.toThrow());
    expect(await db('invoice_payment_log').where({ invoice_id: id })).toHaveLength(0);
    const after = await db('invoices').where({ id }).first();
    expect(after.status).toBe(before.status);
    expect(Number(after.paid_amount_minor)).toBe(Number(before.paid_amount_minor));
  });

  it('rolls back a line-item edit: the old items survive', async () => {
    const [id] = await createViaRoute();
    const itemsBefore = await db('invoice_line_items').where({ invoice_id: id }).orderBy('id');
    const res = await withHistoryTableOffline(() => request(invoiceApp)
      .put(`/api/admin/invoices/${id}`).set(auth())
      .send({ lineItems: [{ position: 1, quantity: 1, description: 'Replaced', unitPriceMinor: 100, discountPercent: 0 }] }));
    expect(res.status).toBe(500);
    const itemsAfter = await db('invoice_line_items').where({ invoice_id: id }).orderBy('id');
    expect(itemsAfter.map((li) => li.description)).toEqual(itemsBefore.map((li) => li.description));
    expect(Number((await db('invoices').where({ id }).first()).net_amount_minor)).toBe(210000);
  });
});
