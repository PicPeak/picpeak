/**
 * Change history (migration 219) for expenses, incoming invoices and the
 * invoice rows the hours and re-bill flows amend.
 *
 * Each service write goes through the audited recorder; these tests pin which
 * history rows each flow leaves (action, entity, changed columns, actor) and
 * that a history row that cannot be written rolls the business change back.
 */
const fs = require('fs');
const path = require('path');
const { bootCrmDb, seedMinimal } = require('./helpers/crmDb');

jest.setTimeout(120000);

let db; let cleanup; let tmpDir; let adminId;
let expenseService; let hoursService; let customerAccountsService; let history;
let seq = 0;

const now = () => new Date().toISOString();
const unwrapId = (ins) => (typeof ins[0] === 'object' ? ins[0].id : ins[0]);
const historyOf = (type, id) => history.listHistory(type, id);
const adminActor = () => ({ type: 'admin', id: adminId, name: null });

async function withHistoryTableOffline(work) {
  await db.schema.renameTable('accounting_change_history', 'accounting_change_history_offline');
  try {
    return await work();
  } finally {
    await db.schema.renameTable('accounting_change_history_offline', 'accounting_change_history');
  }
}

async function makeCustomer(billingCadence, extra = {}) {
  seq += 1;
  return unwrapId(await db('customer_accounts').insert({
    email: `hist-${seq}@example.com`,
    display_name: `History ${seq}`,
    password_hash: 'x',
    preferred_language: 'de',
    is_active: 1,
    billing_cadence: billingCadence,
    hourly_rate_minor: 12000,
    created_at: now(),
    ...extra,
  }).returning('id'));
}

// Fixture rows are written directly: only the service calls under test may
// leave history.
async function captureDoc(overrides = {}) {
  return unwrapId(await db('inbound_documents').insert({
    source: 'upload',
    status: 'unsorted',
    parse_status: 'pending',
    parse_method: 'none',
    supplier_name: 'ACME AG',
    currency: 'CHF',
    total_amount_minor: 10000,
    invoice_date: '2026-06-01',
    created_at: now(),
    updated_at: now(),
    ...overrides,
  }).returning('id'));
}

async function makeInvoice(customerId, lines, extra = {}) {
  seq += 1;
  const net = lines.reduce((sum, l) => sum + l, 0);
  const invoiceId = unwrapId(await db('invoices').insert({
    invoice_number: `HX-${seq}`,
    customer_account_id: customerId,
    status: 'scheduled',
    currency: 'CHF',
    issue_date: '2026-06-01',
    due_date: '2026-07-01',
    vat_rate: 0,
    net_amount_minor: net,
    vat_amount_minor: 0,
    total_amount_minor: net,
    created_at: now(),
    updated_at: now(),
    ...extra,
  }).returning('id'));
  const lineIds = [];
  for (let i = 0; i < lines.length; i += 1) {
    lineIds.push(unwrapId(await db('invoice_line_items').insert({
      invoice_id: invoiceId, position: i + 1, quantity: 1, description: `Line ${i + 1}`,
      unit_price_minor: lines[i], discount_percent: 0, line_total_minor: lines[i],
    }).returning('id')));
  }
  return { invoiceId, lineIds };
}

async function makeExpense(extra = {}) {
  return unwrapId(await db('expenses').insert({
    disposition: 'eigener_aufwand',
    tax_treatment: 'domestic',
    kind: 'amount',
    description: 'Parking',
    chf_amount_minor: 2000,
    gross_amount_minor: 2000,
    status: 'open',
    created_at: now(),
    updated_at: now(),
    ...extra,
  }).returning('id'));
}

beforeAll(async () => {
  ({ db, cleanup, tmpDir } = await bootCrmDb());
  // logActivity writes through the global db; inside the service transactions
  // that deadlocks SQLite (see incomingInvoiceRebill.test.js). Stub it before
  // the services destructure it.
  const dbModule = require('../../src/database/db');
  dbModule.logActivity = async () => {};
  ({ adminId } = await seedMinimal(db));
  history = require('../../src/services/accountingHistory');
  expenseService = require('../../src/services/expenseService');
  hoursService = require('../../src/services/customerHoursService');
  customerAccountsService = require('../../src/services/customerAccountsService');
  // updateEntry reads a cached schema check through the global db inside its
  // transaction; a cold cache deadlocks SQLite (the hasColumnCached gotcha).
  await hoursService.getInstallDefaultRateMinor();
});

afterAll(async () => { if (cleanup) await cleanup(); });

describe('incoming invoices', () => {
  it('records a captured document with the admin, or the mail intake as a system actor', async () => {
    const filePath = path.join(tmpDir, 'supplier.txt');
    await fs.promises.writeFile(filePath, 'supplier invoice');

    const uploaded = await expenseService.recordInboundDocument(
      { source: 'upload', filePath, originalFilename: 'supplier.txt', mimeType: 'text/plain' }, adminId,
    );
    const [created] = await historyOf('inbound_document', uploaded.id);
    expect(created).toMatchObject({
      entity_type: 'inbound_document', entity_id: uploaded.id, action: 'created',
      actor: adminActor(), source: 'inbound.record',
    });
    expect(created.changes.status).toEqual({ from: null, to: 'unsorted' });
    expect(created.changes.original_filename).toEqual({ from: null, to: 'supplier.txt' });

    const mailed = await expenseService.recordInboundDocument(
      { source: 'email', filePath, originalFilename: 'again.txt', mimeType: 'text/plain' }, null,
    );
    const [mailCreated] = await historyOf('inbound_document', mailed.id);
    expect(mailCreated.action).toBe('created');
    expect(mailCreated.actor).toEqual({ type: 'system', id: null, name: 'email-intake' });
    expect(mailCreated.changes.status).toEqual({ from: null, to: 'duplicate' });
  });

  it('records edits and the supplier payment', async () => {
    const id = await captureDoc();
    await expenseService.updateInbound(id, { supplierName: 'Beta GmbH', totalAmountMinor: 12500 }, adminId);
    await expenseService.markInboundSupplierPayment(id, { paid: true, paymentMethod: 'cash' }, adminId);

    const [update, payment] = await historyOf('inbound_document', id);
    expect(update).toMatchObject({ action: 'updated', actor: adminActor(), source: 'inbound.update' });
    expect(update.changes).toMatchObject({
      supplier_name: { from: 'ACME AG', to: 'Beta GmbH' },
      total_amount_minor: { from: 10000, to: 12500 },
      parse_status: { from: 'pending', to: 'manual' },
    });
    expect(payment).toMatchObject({ action: 'updated', source: 'inbound.supplierPayment' });
    expect(payment.changes.supplier_payment_method).toEqual({ from: null, to: 'cash' });
    expect(payment.changes.supplier_paid.to).toBeTruthy();
  });

  it('records categorisation, and the invoice stamp when a monthly customer is billed now', async () => {
    const pendingCustomer = await makeCustomer('per_event');
    const pendingId = await captureDoc();
    await expenseService.categorizeInbound(pendingId, { disposition: 'durchlaufend', customerAccountId: pendingCustomer }, adminId);
    const [categorized] = await historyOf('inbound_document', pendingId);
    expect(categorized).toMatchObject({ action: 'updated', actor: adminActor(), source: 'inbound.categorize' });
    expect(categorized.changes).toMatchObject({
      disposition: { from: null, to: 'durchlaufend' },
      status: { from: 'unsorted', to: 'categorized' },
      customer_account_id: { from: null, to: pendingCustomer },
    });

    const monthlyCustomer = await makeCustomer('monthly');
    const billedId = await captureDoc();
    const doc = await expenseService.categorizeInbound(billedId, { disposition: 'rebill', customerAccountId: monthlyCustomer }, adminId);
    expect(doc.billedInvoiceId).toBeTruthy();
    const entries = await historyOf('inbound_document', billedId);
    expect(entries.map((e) => e.source)).toEqual(['inbound.categorize', 'inbound.billNow']);
    expect(entries[1].changes.billed_invoice_id).toEqual({ from: null, to: doc.billedInvoiceId });
    expect(entries[1].changes.billed_invoice_line_item_id.to).toBe(doc.billedInvoiceLineItemId);
  });

  it('records a re-bill, unwinding the prior line and recomputing its invoice', async () => {
    const customerId = await makeCustomer('per_event');
    const { invoiceId, lineIds: [rebillLine, otherLine] } = await makeInvoice(customerId, [4000, 3000]);
    const id = await captureDoc({
      total_amount_minor: 4000, disposition: 'rebill', status: 'categorized',
      customer_account_id: customerId, billed_invoice_id: invoiceId, billed_invoice_line_item_id: rebillLine,
    });

    const { invoiceId: newInvoiceId } = await expenseService.rebillInbound(id, { customerAccountId: customerId }, adminId);

    const invoiceEntries = await historyOf('invoice', invoiceId);
    expect(invoiceEntries.map((e) => [e.entity_type, e.entity_id, e.action])).toEqual([
      ['invoice_line_item', rebillLine, 'deleted'],
      ['invoice', invoiceId, 'updated'],
    ]);
    expect(invoiceEntries[0].changes.line_total_minor).toEqual({ from: 4000, to: null });
    expect(invoiceEntries[1].changes).toEqual({
      net_amount_minor: { from: 7000, to: 3000 },
      total_amount_minor: { from: 7000, to: 3000 },
    });
    expect(invoiceEntries.every((e) => e.source === 'inbound.unwindRebill' && e.actor.id === adminId)).toBe(true);
    expect(await db('invoice_line_items').where({ id: otherLine }).first()).toBeTruthy();

    const docEntries = await historyOf('inbound_document', id);
    expect(docEntries.map((e) => e.source)).toEqual(['inbound.rebill', 'inbound.billNow']);
    expect(docEntries[1].changes.billed_invoice_id).toEqual({ from: invoiceId, to: newInvoiceId });
  });

  it('records the deletion of an invoice the unwind emptied', async () => {
    const customerId = await makeCustomer('per_event');
    const { invoiceId, lineIds: [line] } = await makeInvoice(customerId, [4000]);
    const id = await captureDoc({
      total_amount_minor: 4000, disposition: 'rebill', status: 'categorized',
      customer_account_id: customerId, billed_invoice_id: invoiceId, billed_invoice_line_item_id: line,
    });

    await expenseService.categorizeInbound(id, { disposition: 'eigener_aufwand' }, adminId);

    expect(await db('invoices').where({ id: invoiceId }).first()).toBeUndefined();
    const entries = await historyOf('invoice', invoiceId);
    expect(entries.map((e) => [e.entity_type, e.action])).toEqual([
      ['invoice_line_item', 'deleted'], ['invoice', 'deleted'],
    ]);
    expect(entries[1].changes.invoice_number.from).toMatch(/^HX-/);
    expect(entries[1].actor).toEqual(adminActor());
    const [categorized] = await historyOf('inbound_document', id);
    expect(categorized.changes.billed_invoice_id).toEqual({ from: invoiceId, to: null });
  });

  it('rolls the categorisation back when its history cannot be written', async () => {
    const customerId = await makeCustomer('per_event');
    const { invoiceId, lineIds: [line] } = await makeInvoice(customerId, [4000, 3000]);
    const id = await captureDoc({
      total_amount_minor: 4000, disposition: 'rebill', status: 'categorized',
      customer_account_id: customerId, billed_invoice_id: invoiceId, billed_invoice_line_item_id: line,
    });

    await withHistoryTableOffline(() => expect(
      expenseService.categorizeInbound(id, { disposition: 'eigener_aufwand' }, adminId),
    ).rejects.toThrow());

    expect(await db('invoice_line_items').where({ id: line }).first()).toBeTruthy();
    expect(Number((await db('invoices').where({ id: invoiceId }).first()).net_amount_minor)).toBe(7000);
    expect((await db('inbound_documents').where({ id }).first()).disposition).toBe('rebill');
  });
});

describe('expenses', () => {
  it('records create, update, re-bill and payment', async () => {
    const created = await expenseService.createExpense(
      { kind: 'amount', chfAmountMinor: 4500, description: 'Train' }, adminId,
    );
    await expenseService.updateExpense(created.id, { description: 'Train ticket' }, adminId);
    const customerId = await makeCustomer('monthly');
    const { invoiceId } = await expenseService.rebillExpense(created.id, { customerAccountId: customerId }, adminId);
    await expenseService.markExpensePaid(created.id, { paid: true, paymentMethod: 'card' }, adminId);

    const entries = await historyOf('expense', created.id);
    expect(entries.map((e) => [e.action, e.source])).toEqual([
      ['created', 'expense.create'],
      ['updated', 'expense.update'],
      ['updated', 'expense.rebill'],
      ['updated', 'expense.markPaid'],
    ]);
    expect(entries.every((e) => e.entity_type === 'expense' && e.actor.id === adminId)).toBe(true);
    expect(entries[0].changes.chf_amount_minor).toEqual({ from: null, to: 4500 });
    expect(entries[1].changes).toEqual({ description: { from: 'Train', to: 'Train ticket' } });
    expect(entries[2].changes).toMatchObject({
      status: { from: 'open', to: 'invoiced' },
      billed_invoice_id: { from: null, to: invoiceId },
      customer_account_id: { from: null, to: customerId },
    });
    expect(entries[3].changes.payment_method).toEqual({ from: null, to: 'card' });
  });

  it('rolls the payment back when its history cannot be written', async () => {
    const id = await makeExpense();
    await withHistoryTableOffline(() => expect(
      expenseService.markExpensePaid(id, { paid: true, paymentMethod: 'cash' }, adminId),
    ).rejects.toThrow());
    const row = await db('expenses').where({ id }).first();
    expect(row.payment_method).toBeNull();
    expect(await historyOf('expense', id)).toEqual([]);
  });
});

describe('hour entries on a draft invoice', () => {
  async function billedEntry() {
    const customerId = await makeCustomer('monthly');
    const { invoiceId, lineIds: [line] } = await makeInvoice(customerId, [12000, 5000], { is_monthly_draft: true });
    const entryId = unwrapId(await db('customer_hour_entries').insert({
      customer_account_id: customerId,
      entry_date: '2026-06-02',
      start_time: '09:00',
      end_time: '10:00',
      duration_minutes: 60,
      description: 'Shoot',
      status: 'billed',
      invoice_id: invoiceId,
      invoice_line_item_id: line,
      recorded_by_admin_id: adminId,
      created_at: now(),
      updated_at: now(),
    }).returning('id'));
    return { entryId, invoiceId, line };
  }

  it('records the line item and invoice totals an entry update recomputes', async () => {
    const { entryId, invoiceId, line } = await billedEntry();
    await hoursService.updateEntry(entryId, { endTime: '11:00' }, adminId);

    const entries = await historyOf('invoice', invoiceId);
    expect(entries.map((e) => [e.entity_type, e.entity_id, e.action])).toEqual([
      ['invoice_line_item', line, 'updated'],
      ['invoice', invoiceId, 'updated'],
    ]);
    expect(entries[0].changes.line_total_minor).toEqual({ from: 12000, to: 24000 });
    expect(entries[1].changes.total_amount_minor).toEqual({ from: 17000, to: 29000 });
    expect(entries.every((e) => e.source === 'hours.updateEntry')).toBe(true);
    expect(entries[1].actor).toEqual(adminActor());
  });

  it('records the line item removal and totals when an entry is deleted', async () => {
    const { entryId, invoiceId, line } = await billedEntry();
    await hoursService.deleteEntry(entryId, adminId);

    const entries = await historyOf('invoice', invoiceId);
    expect(entries.map((e) => [e.entity_type, e.entity_id, e.action])).toEqual([
      ['invoice_line_item', line, 'deleted'],
      ['invoice', invoiceId, 'updated'],
    ]);
    expect(entries[1].changes.net_amount_minor).toEqual({ from: 17000, to: 5000 });
    expect(entries.every((e) => e.source === 'hours.deleteEntry' && e.actor.id === adminId)).toBe(true);
  });
});

describe('customer erasure', () => {
  it('records returning pending re-bills to the inbox under the erasing admin', async () => {
    const customerId = await makeCustomer('per_event');
    const pending = await captureDoc({ disposition: 'rebill', status: 'categorized', customer_account_id: customerId });
    const { invoiceId } = await makeInvoice(customerId, [1000]);
    const billed = await captureDoc({
      disposition: 'rebill', status: 'categorized', customer_account_id: customerId, billed_invoice_id: invoiceId,
    });

    await customerAccountsService.eraseCustomer(customerId, adminId);

    const [update] = await historyOf('inbound_document', pending);
    expect(update).toMatchObject({ action: 'updated', actor: adminActor(), source: 'customer.erase' });
    expect(update.changes).toEqual({
      customer_account_id: { from: customerId, to: null },
      disposition: { from: 'rebill', to: null },
      status: { from: 'categorized', to: 'unsorted' },
    });
    expect(await historyOf('inbound_document', billed)).toEqual([]);
  });
});
