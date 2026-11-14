/**
 * A monthly or manual-billing customer's running draft collects new items
 * only while it is still `scheduled`. Cancelling it closes it, so the next
 * item opens a fresh draft; it cannot be marked paid before it was sent; and
 * hour entries on a closed draft are locked.
 *
 * Real SQLite with the full core-migration run (helpers/crmDb).
 */

const request = require('supertest');
const { formatBoolean } = require('../../src/utils/dbCompat');
const {
  bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken, buildRouteApp, setFeatureFlags,
} = require('./helpers/crmDb');

jest.setTimeout(120000);

let db;
let cleanup;
let tmpDir;
let adminId;
let token;
let app;
let hours;
let seq = 0;

const prevCwd = process.cwd();
const auth = () => ({ Authorization: `Bearer ${token}` });

async function manualCustomer(cadence = 'manual') {
  seq += 1;
  const inserted = await db('customer_accounts').insert({
    email: `manual-${seq}@example.com`,
    display_name: `Manual ${seq}`,
    password_hash: 'unused',
    preferred_language: 'de',
    is_active: 1,
    billing_cadence: cadence,
    feature_hours_logging: formatBoolean(true),
    created_at: new Date().toISOString(),
  }).returning('id');
  return inserted[0]?.id ?? inserted[0];
}

async function addItem(customerId, amount) {
  const res = await request(app).post('/api/admin/invoices').set(auth()).send({
    customerAccountId: customerId,
    currency: 'CHF',
    vatRate: 0,
    lineItems: [{ position: 1, quantity: 1, description: 'item', unitPriceMinor: amount, discountPercent: 0 }],
  });
  expect({ status: res.status, body: res.body }).toMatchObject({ status: 201 });
  return res.body.invoice.id;
}

const row = (id) => db('invoices').where({ id }).first();

beforeAll(async () => {
  ({ db, cleanup, tmpDir } = await bootCrmDb());
  process.chdir(tmpDir);
  ({ adminId } = await seedMinimal(db));
  await assignAdminRole(db, adminId, 'super_admin');
  token = mintAdminToken(adminId);
  await setFeatureFlags(db, { bills: true, hoursLogging: true });
  app = buildRouteApp('/api/admin/invoices', require('../../src/routes/adminInvoices'));
  hours = require('../../src/services/customerHoursService');
});

afterAll(async () => {
  process.chdir(prevCwd);
  if (cleanup) await cleanup();
});

test('a cancelled draft stays as it was and the next item opens a fresh draft', async () => {
  const customerId = await manualCustomer();
  const draftId = await addItem(customerId, 100000);

  const cancel = await request(app).post(`/api/admin/invoices/${draftId}/cancel`).set(auth());
  expect(cancel.status).toBe(200);
  const cancelled = await row(draftId);
  expect(cancelled.status).toBe('cancelled');
  expect(Boolean(cancelled.is_monthly_draft)).toBe(false);

  const nextId = await addItem(customerId, 50000);
  expect(nextId).not.toBe(draftId);
  expect(Number((await row(draftId)).total_amount_minor)).toBe(100000);
  const next = await row(nextId);
  expect(next.status).toBe('scheduled');
  expect(Boolean(next.is_monthly_draft)).toBe(true);
  expect(Number(next.total_amount_minor)).toBe(50000);
});

test('the running draft cannot be marked paid before it is sent', async () => {
  const customerId = await manualCustomer();
  const draftId = await addItem(customerId, 100000);

  const paid = await request(app).post(`/api/admin/invoices/${draftId}/mark-paid`).set(auth()).send({ amountMinor: 100000 });
  expect(paid.status).toBe(409);
  expect(paid.body.code).toBe('MONTHLY_DRAFT_NOT_PAYABLE');
  const after = await row(draftId);
  expect(after.status).toBe('scheduled');
  expect(Number(after.paid_amount_minor || 0)).toBe(0);
});

test('a draft closed while still flagged no longer takes items, from invoices or hours', async () => {
  // Rows left by a cancel or payment that kept the draft flag.
  for (const status of ['cancelled', 'paid']) {
    const customerId = await manualCustomer();
    const draftId = await addItem(customerId, 100000);
    await db('invoices').where({ id: draftId }).update({ status });

    const nextId = await addItem(customerId, 25000);
    expect(nextId).not.toBe(draftId);
    const closed = await row(draftId);
    expect(closed.status).toBe(status);
    expect(Number(closed.total_amount_minor)).toBe(100000);
    expect(Boolean(closed.is_monthly_draft)).toBe(false);

    const entry = await hours.createEntry(customerId, {
      entryDate: '2026-11-10', startTime: '09:00', endTime: '11:00', hourlyRateMinorOverride: 10000,
    }, adminId);
    expect(entry.invoiceId).toBe(nextId);
    expect(Number((await row(draftId)).total_amount_minor)).toBe(100000);
  }
});

test('hour entries on a cancelled draft are locked', async () => {
  const customerId = await manualCustomer();
  const entry = await hours.createEntry(customerId, {
    entryDate: '2026-11-10', startTime: '09:00', endTime: '10:00', hourlyRateMinorOverride: 10000,
  }, adminId);
  const draft = await row(entry.invoiceId);
  expect(Boolean(draft.is_monthly_draft)).toBe(true);

  // A row cancelled before cancelling cleared the flag, and one cancelled now.
  await db('invoices').where({ id: draft.id }).update({ status: 'cancelled' });
  expect(hours._internal.isEntryLocked({ invoice_id: draft.id }, await row(draft.id))).toBe(true);
  await expect(hours.updateEntry(entry.id, { endTime: '12:00' }, adminId))
    .rejects.toMatchObject({ code: 'ENTRY_LOCKED' });
  expect(Number((await row(draft.id)).total_amount_minor)).toBe(Number(draft.total_amount_minor));
});

test('the scheduler returns hours on a draft cancelled before this release to unbilled', async () => {
  const customerId = await manualCustomer();
  const entry = await hours.createEntry(customerId, {
    entryDate: '2026-11-10', startTime: '09:00', endTime: '10:00', hourlyRateMinorOverride: 10000,
  }, adminId);
  // Cancelled the old way: status changed, draft flag and hour link kept.
  await db('invoices').where({ id: entry.invoiceId }).update({ status: 'cancelled' });

  await require('../../src/services/invoice/scheduler').runScheduledTasks();

  const released = await db('customer_hour_entries').where({ id: entry.id }).first();
  expect(released.invoice_id).toBeNull();
  expect(released.status).toBe('unbilled');
  expect(Boolean((await row(entry.invoiceId)).is_monthly_draft)).toBe(false);
  await hours.updateEntry(entry.id, { endTime: '12:00' }, adminId);
});

test('the scheduler leaves hours on a paid draft billed', async () => {
  const customerId = await manualCustomer();
  const entry = await hours.createEntry(customerId, {
    entryDate: '2026-11-10', startTime: '09:00', endTime: '10:00', hourlyRateMinorOverride: 10000,
  }, adminId);
  await db('invoices').where({ id: entry.invoiceId }).update({ status: 'paid' });

  await require('../../src/services/invoice/scheduler').runScheduledTasks();

  expect(Number((await db('customer_hour_entries').where({ id: entry.id }).first()).invoice_id))
    .toBe(Number(entry.invoiceId));
});

test('cancelling a running draft returns its hour entries to unbilled, editable', async () => {
  const customerId = await manualCustomer();
  const entry = await hours.createEntry(customerId, {
    entryDate: '2026-11-10', startTime: '09:00', endTime: '10:00', hourlyRateMinorOverride: 10000,
  }, adminId);
  const draftId = entry.invoiceId;
  expect(draftId).toBeTruthy();

  const cancel = await request(app).post(`/api/admin/invoices/${draftId}/cancel`).set(auth());
  expect(cancel.status).toBe(200);

  const released = await db('customer_hour_entries').where({ id: entry.id }).first();
  expect(released.invoice_id).toBeNull();
  expect(released.invoice_line_item_id).toBeNull();
  expect(released.billed_at).toBeNull();
  expect(released.status).toBe('unbilled');
  // The cancelled draft keeps its record unchanged.
  expect((await row(draftId)).status).toBe('cancelled');
  expect(Number((await row(draftId)).total_amount_minor)).toBe(10000);

  await hours.updateEntry(entry.id, { endTime: '12:00' }, adminId);
  expect(Number((await db('customer_hour_entries').where({ id: entry.id }).first()).duration_minutes)).toBe(180);
  expect(Number((await row(draftId)).total_amount_minor)).toBe(10000);
});

test('hours on a cancelled per-event draft can be billed again', async () => {
  const customerId = await manualCustomer('per_event');
  const entry = await hours.createEntry(customerId, {
    entryDate: '2026-11-11', startTime: '09:00', endTime: '11:00', hourlyRateMinorOverride: 10000,
  }, adminId);
  const first = await hours.billUnbilledEntries(customerId, adminId);

  const cancel = await request(app).post(`/api/admin/invoices/${first.invoiceId}/cancel`).set(auth());
  expect(cancel.status).toBe(200);

  const second = await hours.billUnbilledEntries(customerId, adminId);
  expect(second.invoiceId).not.toBe(first.invoiceId);
  expect(second.entriesBilled).toBe(1);
  const rebilled = await db('customer_hour_entries').where({ id: entry.id }).first();
  expect(rebilled.invoice_id).toBe(second.invoiceId);
  expect(rebilled.status).toBe('billed');
});

test('a draft closed while still flagged is not shown as the running bill, and the scheduler releases it', async () => {
  const invoiceService = require('../../src/services/invoiceService');
  const customerId = await manualCustomer();
  const draftId = await addItem(customerId, 100000);
  await db('invoices').where({ id: draftId }).update({ status: 'cancelled' });

  expect(await invoiceService.getMonthlyDraft(customerId)).toBeNull();
  await require('../../src/services/invoice/scheduler').runScheduledTasks();
  const released = await row(draftId);
  expect(released.status).toBe('cancelled');
  expect(Boolean(released.is_monthly_draft)).toBe(false);
});
