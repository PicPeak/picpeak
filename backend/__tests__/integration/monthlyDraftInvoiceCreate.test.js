/**
 * Creating an invoice for a monthly or manual-billing customer.
 *
 * For these customers createInvoice appends the line items to the customer's
 * running draft instead of minting an invoice. appendToMonthlyDraft returns
 * the draft id itself, but createInvoice read `.id` off it, so `invoiceIds`
 * came back empty: the bill editor's save (POST /api/admin/invoices) answered
 * 500 after the lines had already been appended, and saving again appended
 * them twice.
 *
 * Real SQLite with the full core-migration run (helpers/crmDb).
 */

const request = require('supertest');
const { formatBoolean } = require('../../src/utils/dbCompat');
const {
  bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken, buildRouteApp,
} = require('./helpers/crmDb');

// Full migration run + cold-requiring the CRM services is slow under CI load;
// matches the other CRM integration suites.
jest.setTimeout(120000);

let db;
let cleanup;
let tmpDir;
let adminId;
let token;
let invoiceApp;

const prevCwd = process.cwd();

beforeAll(async () => {
  ({ db, cleanup, tmpDir } = await bootCrmDb());
  // Business-doc storage paths are anchored under process.cwd() — keep them
  // inside the temp dir.
  process.chdir(tmpDir);
  db.client.pool.acquireTimeoutMillis = 2000;

  ({ adminId } = await seedMinimal(db));
  await assignAdminRole(db, adminId, 'super_admin');
  token = mintAdminToken(adminId);

  // The bills surface is feature-flagged; migration 107 seeds it off.
  const value = formatBoolean(true);
  const updated = await db('feature_flags').where({ key: 'bills' }).update({ value });
  if (!updated) await db('feature_flags').insert({ key: 'bills', value });

  invoiceApp = buildRouteApp('/api/admin/invoices', require('../../src/routes/adminInvoices'));
}, 120000);

afterAll(async () => {
  process.chdir(prevCwd);
  if (cleanup) await cleanup();
});

describe.each(['monthly', 'manual'])('POST /api/admin/invoices for a %s-billing customer', (cadence) => {
  test('returns the running draft and appends each save once', async () => {
    const inserted = await db('customer_accounts').insert({
      email: `${cadence}-billing@example.com`,
      display_name: `${cadence} customer`,
      password_hash: 'unused',
      preferred_language: 'de',
      is_active: 1,
      billing_cadence: cadence,
      created_at: new Date().toISOString(),
    }).returning('id');
    const customerId = inserted[0]?.id ?? inserted[0];

    const save = (description) => request(invoiceApp)
      .post('/api/admin/invoices')
      .set('Authorization', `Bearer ${token}`)
      .send({
        customerAccountId: customerId,
        currency: 'CHF',
        vatRate: 0,
        lineItems: [{ position: 1, quantity: 1, description, unitPriceMinor: 10000, discountPercent: 0 }],
      });

    // Status and body together, so a failing request shows the server's error.
    const first = await save('First');
    expect({ status: first.status, body: first.body }).toMatchObject({ status: 201 });
    expect(first.body.invoiceIds).toEqual([first.body.invoice.id]);

    const second = await save('Second');
    expect({ status: second.status, body: second.body }).toMatchObject({ status: 201 });
    expect(second.body.invoice.id).toBe(first.body.invoice.id);

    const stored = await db('invoice_line_items')
      .where({ invoice_id: first.body.invoice.id })
      .orderBy('position', 'asc');
    expect(stored.map((li) => li.description)).toEqual(['First', 'Second']);
  });
});

// Quote → invoice conversion takes the same shortcut for monthly customers
// through spawnInstallmentInvoices, with the same misread return value.
test('quote conversion for a monthly-billing customer returns the draft id', async () => {
  // Required here, not at the top: the service binds to the database that
  // bootCrmDb configured in beforeAll.
  const invoiceService = require('../../src/services/invoiceService');
  const inserted = await db('customer_accounts').insert({
    email: 'monthly-conversion@example.com',
    display_name: 'monthly conversion customer',
    password_hash: 'unused',
    preferred_language: 'de',
    is_active: 1,
    billing_cadence: 'monthly',
    created_at: new Date().toISOString(),
  }).returning('id');
  const customer = await db('customer_accounts').where({ id: inserted[0]?.id ?? inserted[0] }).first();

  const { invoiceIds } = await db.transaction((trx) => invoiceService.spawnInstallmentInvoices({
    trx,
    customer,
    adminId,
    lineItems: [{
      position: 1, quantity: 1, description: 'From quote', unit_price_minor: 10000, discount_percent: 0, parent_position: null,
    }],
    totals: { vatRate: 0 },
  }));

  expect(invoiceIds).toHaveLength(1);
  const draft = await db('invoices').where({ id: invoiceIds[0] }).first();
  expect(Boolean(draft.is_monthly_draft)).toBe(true);
  expect(draft.customer_account_id).toBe(customer.id);
});

describe.each(['monthly', 'manual'])('%s re-bills inside a transaction', (cadence) => {
  test.each(['incoming document', 'expense'])('%s creates a draft, then appends and links the next line', async (kind) => {
    const expenseService = require('../../src/services/expenseService');
    const [inserted] = await db('customer_accounts').insert({
      email: `${cadence}-${kind.replace(/ /g, '-')}@example.com`,
      display_name: `${cadence} re-bill customer`, password_hash: 'unused',
      is_active: formatBoolean(true), billing_cadence: cadence,
    }).returning('id');
    const customerId = inserted.id ?? inserted;
    let invoiceId;
    for (const description of ['First', 'Second']) {
      let billedId;
      let billedLineId;
      if (kind === 'incoming document') {
        const [document] = await db('inbound_documents').insert({
          source: 'upload', status: 'unsorted', parse_status: 'pending', parse_method: 'none',
          supplier_name: description, currency: 'CHF', total_amount_minor: 10000,
          invoice_date: '2026-09-15',
        }).returning('id');
        const id = document.id ?? document;
        const result = await expenseService.categorizeInbound(id, {
          disposition: 'rebill', customerAccountId: customerId, markupType: 'none',
        }, adminId);
        billedId = result.billedInvoiceId;
        const stored = await db('inbound_documents').where({ id }).first();
        billedLineId = stored.billed_invoice_line_item_id;
      } else {
        const expense = await expenseService.createExpense({
          kind: 'amount', chfAmountMinor: 10000, description,
        }, adminId);
        const result = await expenseService.rebillExpense(expense.id, { customerAccountId: customerId }, adminId);
        billedId = result.invoiceId;
        billedLineId = result.expense.billedInvoiceLineItemId;
      }
      expect(billedId).toBeGreaterThan(0);
      if (invoiceId) expect(billedId).toBe(invoiceId);
      invoiceId = billedId;
      const latest = await db('invoice_line_items').where({ invoice_id: invoiceId }).orderBy('id', 'desc').first();
      expect(billedLineId).toBe(latest.id);
    }
    const rows = await db('invoice_line_items').where({ invoice_id: invoiceId }).orderBy('position');
    expect(rows.map((row) => row.position)).toEqual([1, 2]);
    const draft = await db('invoices').where({ id: invoiceId }).first();
    expect(Number(draft.total_amount_minor)).toBe(20000);
    const logs = await db('activity_logs').where({ activity_type: 'monthly_billing_items_queued' });
    const metadata = logs.map((row) => typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata);
    expect(metadata.filter((entry) => entry.invoiceId === invoiceId)).toHaveLength(2);
  });
});
