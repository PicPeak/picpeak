/**
 * Every invoice activity line names its invoice.
 *
 * The notifications, the dashboard feed and the customer activity card word
 * these types as "Payment-check sent for invoice: {{invoiceNumber}}". Only
 * invoice_created and invoice_scheduled recorded the number, so the other
 * lines showed the raw placeholder. This drives each flow and checks the row.
 */
const request = require('supertest');
const {
  bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken, buildRouteApp,
} = require('./helpers/crmDb');

jest.setTimeout(120000);

let db; let cleanup; let tmpDir; let adminId; let customerId; let token; let invoiceApp;
const prevCwd = process.cwd();
const auth = () => ({ Authorization: `Bearer ${token}` });

async function draftInvoice() {
  const res = await request(invoiceApp).post('/api/admin/invoices').set(auth()).send({
    customerAccountId: customerId,
    currency: 'CHF',
    lineItems: [{ position: 1, quantity: 1, description: 'Coverage', unitPriceMinor: 10000, discountPercent: 0 }],
  });
  expect(res.status).toBe(201);
  return Number(res.body.invoiceIds[0]);
}

const numberOf = async (id) => (await db('invoices').where({ id }).first('invoice_number')).invoice_number;
const metaOf = (row) => (typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata);
async function loggedNumber(type, match) {
  const rows = await db('activity_logs').where({ activity_type: type }).orderBy('id', 'desc');
  const row = rows.find((r) => match(metaOf(r)));
  expect(row).toBeDefined();
  return metaOf(row).invoiceNumber;
}

beforeAll(async () => {
  ({ db, cleanup, tmpDir } = await bootCrmDb());
  process.chdir(tmpDir);
  // Under jest's vm sandbox node-sqlite3 stores service-created Dates as
  // "[object Object]"; normalise bindings the way the other invoice suites do.
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

  ({ adminId, customerId } = await seedMinimal(db));
  await assignAdminRole(db, adminId, 'super_admin');
  token = mintAdminToken(adminId);
  const updated = await db('feature_flags').where({ key: 'bills' }).update({ value: true });
  if (!updated) await db('feature_flags').insert({ key: 'bills', value: true });
  const profile = await db('business_profile').first();
  if (profile) await db('business_profile').where({ id: profile.id }).update({ email: 'studio@example.com' });
  invoiceApp = buildRouteApp('/api/admin/invoices', require('../../src/routes/adminInvoices'));
});

afterAll(async () => {
  process.chdir(prevCwd);
  if (cleanup) await cleanup();
});

describe('invoice activity rows carry the invoice number', () => {
  it('send, payment check, reminder, Storno and reissue', async () => {
    const sending = require('../../src/services/invoice/sending');
    const payments = require('../../src/services/invoice/payments');
    const reminders = require('../../src/services/invoice/reminders');

    const id = await draftInvoice();
    const number = await numberOf(id);
    await sending.sendInvoice(id, adminId);
    expect(await loggedNumber('invoice_sent', (m) => m.invoiceId === id)).toBe(number);

    await reminders.sendReminder(id, 1, adminId);
    expect(await loggedNumber('invoice_reminder_sent', (m) => m.invoiceId === id)).toBe(number);

    const { token: checkToken } = await payments.queuePaymentCheckEmail(id, { skipThrottle: true });
    expect(await loggedNumber('invoice_payment_check_sent', (m) => m.invoiceId === id)).toBe(number);
    await payments.recordPaymentCheckAction({ token: checkToken, action: 'unpaid', ip: '127.0.0.1' });
    expect(await loggedNumber('invoice_payment_check_recorded', (m) => m.invoiceId === id)).toBe(number);

    const { id: newId, stornoId } = await sending.reissueInvoice(id, adminId);
    expect(await loggedNumber('invoice_cancelled_via_storno', (m) => m.invoiceId === id)).toBe(number);
    expect(await loggedNumber('invoice_reissued', (m) => m.newInvoiceId === newId)).toBe(number);
    expect(await loggedNumber('storno_sent', (m) => m.stornoId === stornoId)).toBe(await numberOf(stornoId));
  });

  it('release for delivery and a soft cancel', async () => {
    const sending = require('../../src/services/invoice/sending');

    const released = await draftInvoice();
    await db('invoices').where({ id: released }).update({ status: 'pending_delivery' });
    await sending.releaseForDelivery(released, adminId);
    expect(await loggedNumber('invoice_released_for_delivery', (m) => m.invoiceId === released))
      .toBe(await numberOf(released));

    const cancelled = await draftInvoice();
    await sending.cancelInvoice(cancelled, adminId);
    expect(await loggedNumber('invoice_cancelled', (m) => m.invoiceId === cancelled))
      .toBe(await numberOf(cancelled));
  });

  it('a paid-invoice notice to the admin', async () => {
    const payments = require('../../src/services/invoice/payments');
    const id = await draftInvoice();
    await require('../../src/services/invoice/sending').sendInvoice(id, adminId);
    await payments.markPaid(id, { amountMinor: 10000, paidAt: '2026-11-05', paymentMethod: 'bank' }, adminId);
    expect(await loggedNumber('invoice_paid_admin_notified', (m) => m.invoiceId === id)).toBe(await numberOf(id));
  });
});
