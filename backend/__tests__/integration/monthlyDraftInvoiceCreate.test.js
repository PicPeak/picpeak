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

  const { invoiceIds } = await invoiceService.spawnInstallmentInvoices({
    trx: db,
    customer,
    adminId,
    lineItems: [{
      position: 1, quantity: 1, description: 'From quote', unit_price_minor: 10000, discount_percent: 0, parent_position: null,
    }],
    totals: { vatRate: 0 },
  });

  expect(invoiceIds).toHaveLength(1);
  const draft = await db('invoices').where({ id: invoiceIds[0] }).first();
  expect(Boolean(draft.is_monthly_draft)).toBe(true);
  expect(draft.customer_account_id).toBe(customer.id);
});
