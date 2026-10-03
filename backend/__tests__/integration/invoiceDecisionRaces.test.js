/**
 * One decision per invoice: payment-check links and cancellation.
 *
 * Payment-check links were independent rows. An unused 72-hour link outlived
 * the payment or Storno that settled the invoice and could restore `overdue`
 * with a late fee and a reminder; two live links could each confirm the full
 * payment from the same snapshot. Now a new link supersedes the older ones, a
 * settled invoice revokes its pending links, and the redemption decides in one
 * transaction: lock, state check, outstanding amount, claim of every pending
 * link.
 */
const request = require('supertest');
const {
  bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken, buildRouteApp,
} = require('./helpers/crmDb');

jest.setTimeout(120000);

let db; let cleanup; let tmpDir; let adminId; let customerId; let token;
let invoiceApp; let invoiceService; let payments; let reminders;
const prevCwd = process.cwd();

const auth = () => ({ Authorization: `Bearer ${token}` });
const codeOf = async (promise) => {
  try { await promise; return null; } catch (err) { return err.code || err.statusCode; }
};
const invoiceRow = (id) => db('invoices').where({ id }).first();
const tokensOf = (id) => db('invoice_payment_check_tokens').where({ invoice_id: id }).orderBy('id');
let seq = 0;

async function createViaRoute() {
  const res = await request(invoiceApp).post('/api/admin/invoices').set(auth()).send({
    customerAccountId: customerId,
    currency: 'CHF',
    lineItems: [{ position: 1, quantity: 1, description: 'Coverage', unitPriceMinor: 10000, discountPercent: 0 }],
  });
  expect(res.status).toBe(201);
  return res.body.invoiceIds.map(Number);
}

async function sentInvoice() {
  const [id] = await createViaRoute();
  await request(invoiceApp).post(`/api/admin/invoices/${id}/send`).set(auth()).send({}).expect(200);
  return id;
}

/** A live payment-check link inserted directly, the way an older email's would still exist. */
async function liveToken(invoiceId) {
  seq += 1;
  const value = `${seq.toString(16).padStart(4, '0')}${'b'.repeat(60)}`;
  await db('invoice_payment_check_tokens').insert({
    invoice_id: invoiceId,
    token: value,
    expires_at: new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString(),
    created_at: new Date().toISOString(),
  });
  return value;
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
  db.client.pool.acquireTimeoutMillis = 2000;

  ({ adminId, customerId } = await seedMinimal(db));
  await assignAdminRole(db, adminId, 'super_admin');
  token = mintAdminToken(adminId);
  const updated = await db('feature_flags').where({ key: 'bills' }).update({ value: true });
  if (!updated) await db('feature_flags').insert({ key: 'bills', value: true });
  const profile = await db('business_profile').first();
  if (profile) await db('business_profile').where({ id: profile.id }).update({ email: 'studio@example.com' });

  invoiceService = require('../../src/services/invoiceService');
  payments = require('../../src/services/invoice/payments');
  reminders = require('../../src/services/invoice/reminders');
  invoiceApp = buildRouteApp('/api/admin/invoices', require('../../src/routes/adminInvoices'));
});

afterAll(async () => {
  process.chdir(prevCwd);
  if (cleanup) await cleanup();
});

describe('payment-check links', () => {
  it('a new link supersedes the older unused one', async () => {
    const id = await sentInvoice();
    const older = await liveToken(id);

    const result = await payments.queuePaymentCheckEmail(id, { skipThrottle: true });
    expect(result.sent).toBe(true);

    const rows = await tokensOf(id);
    expect(rows).toHaveLength(2);
    const olderRow = rows.find((r) => r.token === older);
    expect(olderRow.used_at).not.toBeNull();
    expect(olderRow.used_action).toBe('superseded');
    expect(rows.find((r) => r.token === result.token).used_at).toBeNull();
    expect(await codeOf(payments.getPaymentCheckByToken(older))).toBe('TOKEN_ALREADY_USED');
    expect(await codeOf(payments.recordPaymentCheckAction({ token: older, action: 'unpaid' }))).toBe('TOKEN_ALREADY_USED');
  });

  it('a recorded payment revokes the pending links', async () => {
    const id = await sentInvoice();
    const link = await liveToken(id);

    await invoiceService.markPaid(id, { amountMinor: 10000 }, adminId);

    expect((await invoiceRow(id)).status).toBe('paid');
    const [row] = await tokensOf(id);
    expect(row.token).toBe(link);
    expect(row.used_action).toBe('revoked');
    expect(await codeOf(payments.recordPaymentCheckAction({ token: link, action: 'unpaid' }))).toBe('TOKEN_ALREADY_USED');
  });

  it('a link that somehow outlived the payment cannot reopen a paid invoice', async () => {
    const id = await sentInvoice();
    await invoiceService.markPaid(id, { amountMinor: 10000 }, adminId);
    const stale = await liveToken(id);
    const before = await invoiceRow(id);
    const emailsBefore = await db('email_queue').count('* as n').first();

    expect(await codeOf(payments.getPaymentCheckByToken(stale))).toBe('INVOICE_NOT_ACTIONABLE');
    expect(await codeOf(payments.recordPaymentCheckAction({ token: stale, action: 'unpaid' }))).toBe('INVOICE_NOT_ACTIONABLE');
    expect(await codeOf(payments.recordPaymentCheckAction({ token: stale, action: 'paid_full' }))).toBe('INVOICE_NOT_ACTIONABLE');

    const after = await invoiceRow(id);
    expect(after.status).toBe('paid');
    expect(after.reminder_level).toBe(before.reminder_level);
    expect(Number(after.late_fee_amount_minor || 0)).toBe(0);
    expect(Number(after.paid_amount_minor)).toBe(10000);
    // Nothing was consumed either: the refusal is before the claim.
    expect((await tokensOf(id)).find((r) => r.token === stale).used_at).toBeNull();
    expect(await db('email_queue').count('* as n').first()).toEqual(emailsBefore);
    expect(await db('invoice_payment_log').where({ invoice_id: id })).toHaveLength(1);
  });

  it('a link cannot act on a cancelled invoice', async () => {
    const id = await sentInvoice();
    const link = await liveToken(id);

    await invoiceService.cancelInvoice(id, adminId);

    // Cancelling revoked it…
    expect((await tokensOf(id))[0].used_action).toBe('revoked');
    // …and a link inserted afterwards is refused on the invoice's state.
    const stale = await liveToken(id);
    expect(await codeOf(payments.recordPaymentCheckAction({ token: stale, action: 'unpaid' }))).toBe('INVOICE_NOT_ACTIONABLE');
    expect(await codeOf(payments.recordPaymentCheckAction({ token: link, action: 'unpaid' }))).toBe('TOKEN_ALREADY_USED');
    const row = await invoiceRow(id);
    expect(row.status).toBe('cancelled');
    expect(Number(row.late_fee_amount_minor || 0)).toBe(0);
  });

  it('two live links confirm one payment, not two', async () => {
    const id = await sentInvoice();
    const first = await liveToken(id);
    const second = await liveToken(id);

    await expect(payments.recordPaymentCheckAction({ token: first, action: 'paid_full', ip: '203.0.113.7' }))
      .resolves.toEqual({ applied: 'paid_full' });
    expect(await codeOf(payments.recordPaymentCheckAction({ token: second, action: 'paid_full' }))).toBe('TOKEN_ALREADY_USED');

    const rows = await tokensOf(id);
    expect(rows.find((r) => r.token === first)).toMatchObject({ used_action: 'paid_full' });
    expect(rows.find((r) => r.token === second)).toMatchObject({ used_action: 'superseded' });
    expect(await db('invoice_payment_log').where({ invoice_id: id })).toHaveLength(1);
    const row = await invoiceRow(id);
    expect(row.status).toBe('paid');
    expect(Number(row.paid_amount_minor)).toBe(10000);
  });

  it('the reminder writer refuses an invoice that is no longer awaiting payment', async () => {
    const id = await sentInvoice();
    await invoiceService.markPaid(id, { amountMinor: 10000 }, adminId);
    const invoice = { ...(await invoiceRow(id)), status: 'sent' }; // a stale snapshot
    const lineItems = await db('invoice_line_items').where({ invoice_id: id });

    expect(await codeOf(reminders.applyReminder(invoice, lineItems, 1, adminId))).toBe('INVOICE_NOT_ACTIONABLE');

    const row = await invoiceRow(id);
    expect(row.status).toBe('paid');
    expect(row.reminder_level).toBe(0);
  });
});
