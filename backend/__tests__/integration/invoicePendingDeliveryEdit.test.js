/**
 * Editing an invoice that is awaiting delivery.
 *
 * An `after_delivery` installment sits in `pending_delivery` until the admin
 * clicks "Mark delivered & send". The customer and the books do not see it
 * in that state and the scheduler only picks up `scheduled` rows, so it has
 * to stay fixable without a Storno. This pins the gate (pre-send rows save,
 * issued rows stay locked, an edit never releases the invoice), the
 * visibility that makes it safe, and what marking delivered does to the dates.
 */

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');
const { toDateOnly } = require('../../src/utils/dateOnly');
const {
  bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken, buildRouteApp,
} = require('./helpers/crmDb');

jest.setTimeout(120000);

let db;
let cleanup;
let tmpDir;
let customerId;
let token;
let invoiceApp;
let adminId;

const prevCwd = process.cwd();
const auth = { get Authorization() { return `Bearer ${token}`; } };

async function enableFlag(key) {
  const updated = await db('feature_flags').where({ key }).update({ value: true });
  if (!updated) await db('feature_flags').insert({ key, value: true });
}

async function makeInvoice(status) {
  const created = await request(invoiceApp).post('/api/admin/invoices').set(auth).send({
    customerAccountId: customerId,
    currency: 'CHF',
    vatRate: 0,
    eventDate: '2026-10-03',
    lineItems: [{ position: 1, quantity: 1, description: 'Wedding coverage', unitPriceMinor: 200000, discountPercent: 0 }],
  });
  expect(created.status).toBe(201);
  const invoiceId = created.body.invoice.id;
  await db('invoices').where({ id: invoiceId }).update({ status, scheduled_send_at: null });
  return invoiceId;
}

beforeAll(async () => {
  ({ db, cleanup, tmpDir } = await bootCrmDb());
  process.chdir(tmpDir);
  db.client.pool.acquireTimeoutMillis = 2000;
  ({ adminId, customerId } = await seedMinimal(db));
  await assignAdminRole(db, adminId, 'super_admin');
  token = mintAdminToken(adminId);
  await enableFlag('bills');
  invoiceApp = buildRouteApp('/api/admin/invoices', require('../../src/routes/adminInvoices'));
}, 120000);

test('the activity feed resolves numbers the log entry only has as ids', async () => {
  const invoiceId = await makeInvoice('sent');
  const { invoice_number: invoiceNumber } = await db('invoices').where({ id: invoiceId }).first();
  const { withDocumentNumbers } = require('../../src/services/activityDocumentNumbers');

  const entries = await withDocumentNumbers([
    { metadata: { invoiceId } },
    { metadata: { originalInvoiceId: 1, newInvoiceId: invoiceId } },
    { metadata: { stornoId: invoiceId, stornoNumber: 'S-1' } },
    { metadata: { invoiceId, invoiceNumber: 'KEPT' } },
    { metadata: { quoteId: 999999 } },
    { metadata: { email: 'a@example.com' } },
  ]);

  expect(entries[0].metadata.invoiceNumber).toBe(invoiceNumber);
  expect(entries[1].metadata.invoiceNumber).toBe(invoiceNumber);
  expect(entries[2].metadata.invoiceNumber).toBe(invoiceNumber);
  expect(entries[3].metadata.invoiceNumber).toBe('KEPT');
  expect(entries[4].metadata.quoteNumber).toBe('#999999');
  expect(entries[5].metadata).toEqual({ email: 'a@example.com' });
});

afterAll(async () => {
  process.chdir(prevCwd);
  if (cleanup) await cleanup();
});

test('a pending_delivery invoice can still be edited and stays pending', async () => {
  const invoiceId = await makeInvoice('pending_delivery');

  const saved = await request(invoiceApp).put(`/api/admin/invoices/${invoiceId}`).set(auth).send({
    eventDate: '2026-11-14',
  });
  expect(saved.status).toBe(200);

  const after = await db('invoices').where({ id: invoiceId }).first();
  // The date landed...
  expect(toDateOnly(after.event_date)).toBe('2026-11-14');
  // ...and the edit did not release the invoice: it is still waiting on the
  // admin, with no send date for the scheduler to act on.
  expect(after.status).toBe('pending_delivery');
  expect(after.scheduled_send_at).toBeFalsy();
});

test('a delivery invoice refuses a send date instead of dropping it', async () => {
  const invoiceId = await makeInvoice('pending_delivery');

  const saved = await request(invoiceApp).put(`/api/admin/invoices/${invoiceId}`).set(auth).send({
    scheduledSendAt: '2026-12-01T09:00',
  });
  expect(saved.status).toBe(409);
  expect(saved.body.code).toBe('INVOICE_SENDS_ON_DELIVERY');

  const after = await db('invoices').where({ id: invoiceId }).first();
  expect(after.status).toBe('pending_delivery');
  expect(after.scheduled_send_at).toBeFalsy();
});

test('a delivery invoice refuses another issue date, since sending sets it', async () => {
  const invoiceId = await makeInvoice('pending_delivery');
  const before = await db('invoices').where({ id: invoiceId }).first();

  const moved = await request(invoiceApp).put(`/api/admin/invoices/${invoiceId}`).set(auth).send({
    issueDate: '2026-12-24',
  });
  expect(moved.status).toBe(409);
  expect(moved.body.code).toBe('INVOICE_SENDS_ON_DELIVERY');

  // The form always sends the stored date back.
  const unchanged = await request(invoiceApp).put(`/api/admin/invoices/${invoiceId}`).set(auth).send({
    issueDate: toDateOnly(before.issue_date), eventDate: '2026-11-14',
  });
  expect(unchanged.status).toBe(200);
  const after = await db('invoices').where({ id: invoiceId }).first();
  expect(toDateOnly(after.issue_date)).toBe(toDateOnly(before.issue_date));
});

test('skonto can be disabled while awaiting delivery', async () => {
  const invoiceId = await makeInvoice('pending_delivery');

  const saved = await request(invoiceApp).put(`/api/admin/invoices/${invoiceId}`).set(auth).send({ skontoDisabled: true });
  expect(saved.status).toBe(200);
  expect(saved.body.invoice.skontoDisabled).toBe(true);
});

test('a delivery invoice with a payment on it stays locked', async () => {
  const invoiceId = await makeInvoice('pending_delivery');
  await db('invoices').where({ id: invoiceId }).update({ paid_amount_minor: 50000 });

  const saved = await request(invoiceApp).put(`/api/admin/invoices/${invoiceId}`).set(auth).send({
    eventDate: '2026-11-14',
  });
  expect(saved.status).toBe(409);
  expect(saved.body.code).toBe('INVOICE_LOCKED');
});

test('marking delivered re-anchors a machine-set due date and mails it unformatted', async () => {
  const invoiceId = await makeInvoice('pending_delivery');
  const issueDate = '2030-01-15';
  await db('invoices').where({ id: invoiceId }).update({ issue_date: issueDate, due_date: '2030-02-14' });

  const released = await request(invoiceApp).post(`/api/admin/invoices/${invoiceId}/release-for-delivery`).set(auth).send({});
  expect(released.status).toBe(200);

  const after = await db('invoices').where({ id: invoiceId }).first();
  const days = Math.round((Date.parse(toDateOnly(after.due_date)) - Date.parse(toDateOnly(after.issue_date))) / 86400000);
  expect(days).toBe(30);
  expect(toDateOnly(after.due_date)).not.toBe('2030-02-14');

  const mail = await db('email_queue').where({ email_type: 'invoice_sent' }).orderBy('id', 'desc').first();
  const data = typeof mail.email_data === 'string' ? JSON.parse(mail.email_data) : mail.email_data;
  expect(data.due_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
});

test('marking delivered keeps a due date an admin set by hand', async () => {
  const invoiceId = await makeInvoice('pending_delivery');
  await db('invoices').where({ id: invoiceId }).update({ issue_date: '2030-01-15', due_date: '2030-06-30' });

  const released = await request(invoiceApp).post(`/api/admin/invoices/${invoiceId}/release-for-delivery`).set(auth).send({});
  expect(released.status).toBe(200);

  const after = await db('invoices').where({ id: invoiceId }).first();
  expect(toDateOnly(after.due_date)).toBe('2030-06-30');
});

test('a delivery invoice takes no payment until it is marked delivered', async () => {
  const invoiceService = require('../../src/services/invoiceService');
  const invoiceId = await makeInvoice('pending_delivery');

  await expect(invoiceService.markPaid(invoiceId, { amountMinor: 200000 }, adminId))
    .rejects.toMatchObject({ code: 'INVOICE_AWAITING_DELIVERY' });
  const after = await db('invoices').where({ id: invoiceId }).first();
  expect(after.status).toBe('pending_delivery');
  expect(Number(after.paid_amount_minor)).toBe(0);
});

test('reissuing an unpaid delivery invoice points to Edit', async () => {
  const invoiceService = require('../../src/services/invoiceService');
  const invoiceId = await makeInvoice('pending_delivery');

  await expect(invoiceService.reissueInvoice(invoiceId, adminId))
    .rejects.toMatchObject({ statusCode: 409, code: 'USE_EDIT_INSTEAD' });
});

test('an older delivery invoice with a payment on it still cancels through Storno', async () => {
  const invoiceService = require('../../src/services/invoiceService');
  const invoiceId = await makeInvoice('pending_delivery');
  await db('invoices').where({ id: invoiceId }).update({ paid_amount_minor: 50000 });

  const result = await invoiceService.cancelInvoice(invoiceId, adminId);
  expect(result.stornoId).toBeTruthy();
});

test('a save loses to a send that landed after the route read the invoice', async () => {
  const history = require('../../src/services/accountingHistory');
  const invoiceId = await makeInvoice('pending_delivery');
  const lineBefore = await db('invoice_line_items').where({ invoice_id: invoiceId }).first();
  const real = history.auditedUpdate;
  const spy = jest.spyOn(history, 'auditedUpdate').mockImplementationOnce(async (conn, ...rest) => {
    await conn('invoices').where({ id: invoiceId }).update({ status: 'sent' });
    return real(conn, ...rest);
  });

  const saved = await request(invoiceApp).put(`/api/admin/invoices/${invoiceId}`).set(auth).send({
    eventName: 'Too late',
    lineItems: [{ position: 1, quantity: 1, description: 'Too late', unitPriceMinor: 1, discountPercent: 0 }],
  });
  spy.mockRestore();

  expect(saved.status).toBe(409);
  expect(saved.body.code).toBe('INVOICE_LOCKED');
  const lineAfter = await db('invoice_line_items').where({ invoice_id: invoiceId }).first();
  expect(lineAfter.description).toBe(lineBefore.description);
});

test('a machine-set due date follows a changed payment term', async () => {
  const invoiceId = await makeInvoice('pending_delivery');
  await db('invoices').where({ id: invoiceId }).update({
    issue_date: '2030-01-15',
    due_date: '2030-02-14',
    payment_term_snapshot: JSON.stringify({ net_days: 30 }),
  });
  const [templateId] = await db('payment_term_templates').insert({ name: 'Net 10', net_days: 10, description: 'Net 10', installments: '[]' }).returning('id');
  const id = templateId?.id ?? templateId;

  const saved = await request(invoiceApp).put(`/api/admin/invoices/${invoiceId}`).set(auth).send({
    paymentTermTemplateId: id,
  });
  expect(saved.status).toBe(200);
  const after = await db('invoices').where({ id: invoiceId }).first();
  expect(toDateOnly(after.due_date)).toBe('2030-01-25');
});

test('a plan cannot be reshaped over a payment', async () => {
  const invoiceService = require('../../src/services/invoiceService');
  const invoiceId = await makeInvoice('pending_delivery');
  await db('invoices').where({ id: invoiceId }).update({ paid_amount_minor: 50000, installment_total: 2 });
  const { deal_uuid: dealUuid } = await db('invoices').where({ id: invoiceId }).first();

  await expect(db.transaction((trx) => invoiceService.updateInstallmentPlan({
    trx,
    dealUuid,
    installments: [{ label: 'Full', percent: 100, trigger: 'after_delivery', offset_days: 0 }],
    adminId,
  }))).rejects.toMatchObject({ code: 'INVOICE_LOCKED' });
});

test('cancelling a delivery invoice takes no Storno, since nothing was issued', async () => {
  const invoiceService = require('../../src/services/invoiceService');
  const invoiceId = await makeInvoice('pending_delivery');
  const before = await db('invoices').where({ kind: 'storno' }).count('id as c').first();

  const result = await invoiceService.cancelInvoice(invoiceId, adminId);

  expect(result).toEqual({ cancelled: true, stornoId: null });
  const after = await db('invoices').where({ kind: 'storno' }).count('id as c').first();
  expect(Number(after.c)).toBe(Number(before.c));
});

test('the customer sees a delivery invoice only once it is sent', async () => {
  const jwt = require('jsonwebtoken');
  const customerApp = express();
  customerApp.use(express.json());
  customerApp.use(cookieParser());
  customerApp.use('/api/customer', require('../../src/routes/customer'));
  await db('customer_accounts').where({ id: customerId }).update({ feature_bills: true });
  const billsSwitch = { setting_key: 'customer_feature_bills_enabled' };
  const switched = await db('app_settings').where(billsSwitch).update({ setting_value: 'true' });
  if (!switched) await db('app_settings').insert({ ...billsSwitch, setting_value: 'true', setting_type: 'customer_surface' });
  const session = jwt.sign(
    { type: 'customer', customerId, iat: Math.floor(Date.now() / 1000) - 5 },
    process.env.JWT_SECRET,
    { algorithm: 'HS256', issuer: 'picpeak-auth', expiresIn: '1h' },
  );
  const asCustomer = (req) => req.set('Cookie', `customer_token=${session}`);
  const invoiceId = await makeInvoice('pending_delivery');

  const listed = async () => {
    const res = await asCustomer(request(customerApp).get('/api/customer/invoices'));
    expect(res.status).toBe(200);
    return res.body;
  };
  expect(JSON.stringify(await listed())).not.toContain(`"id":${invoiceId},`);
  const pdf = await asCustomer(request(customerApp).get(`/api/customer/invoices/${invoiceId}/pdf`));
  expect(pdf.status).toBe(404);

  await db('invoices').where({ id: invoiceId }).update({ status: 'sent' });
  expect(JSON.stringify(await listed())).toContain(`"id":${invoiceId},`);

  // An older row with a payment was issued: it stays in the list.
  const paidId = await makeInvoice('pending_delivery');
  await db('invoices').where({ id: paidId }).update({ paid_amount_minor: 50000 });
  expect(JSON.stringify(await listed())).toContain(`"id":${paidId},`);
  const paidPdf = await asCustomer(request(customerApp).get(`/api/customer/invoices/${paidId}/pdf`));
  expect(paidPdf.status).not.toBe(404);
});

test('the ledger books a delivery invoice only once it is sent', async () => {
  const ledgerService = require('../../src/services/ledgerService');
  const invoiceId = await makeInvoice('pending_delivery');
  const row = await db('invoices').where({ id: invoiceId }).first();
  const day = toDateOnly(row.issue_date);
  const posted = async () => {
    const postings = await ledgerService.buildPostings({ from: day, to: day, currency: 'CHF' });
    return JSON.stringify(postings).includes(row.invoice_number);
  };

  expect(await posted()).toBe(false);
  await db('invoices').where({ id: invoiceId }).update({ status: 'sent' });
  expect(await posted()).toBe(true);
});

test('an older delivery invoice with a payment stays in the ledger and the tax report', async () => {
  const ledgerService = require('../../src/services/ledgerService');
  const taxReportService = require('../../src/services/taxReportService');
  const invoiceId = await makeInvoice('pending_delivery');
  const row = await db('invoices').where({ id: invoiceId }).first();
  const day = toDateOnly(row.issue_date);
  const booked = async () => [
    JSON.stringify(await ledgerService.buildPostings({ from: day, to: day, currency: 'CHF' })).includes(row.invoice_number),
    JSON.stringify(await taxReportService.getTaxReport({ from: day, to: day, currency: 'CHF' })).includes(row.invoice_number),
  ];

  expect(await booked()).toEqual([false, false]);
  await db('invoices').where({ id: invoiceId }).update({ paid_amount_minor: 50000 });
  expect(await booked()).toEqual([true, true]);
});

test('the feed gives a number only to an admin who may view the invoice', async () => {
  const { formatBoolean } = require('../../src/utils/dbCompat');
  const invoiceId = await makeInvoice('sent');
  const { invoice_number: invoiceNumber } = await db('invoices').where({ id: invoiceId }).first();
  await db('activity_logs').insert({
    activity_type: 'invoice_sent', actor_type: 'admin', actor_id: adminId, metadata: JSON.stringify({ invoiceId }),
  });
  const dashboardApp = buildRouteApp('/api/admin/dashboard', require('../../src/routes/adminDashboard'));
  const makeAdmin = async (name, permissionNames) => {
    const [role] = await db('roles').insert({ name, display_name: name }).returning('id');
    const roleId = role.id ?? role;
    const permissions = await db('permissions').whereIn('name', permissionNames);
    expect(permissions).toHaveLength(permissionNames.length);
    await db('role_permissions').insert(permissions.map((p) => ({ role_id: roleId, permission_id: p.id })));
    const [admin] = await db('admin_users').insert({
      username: name, email: `${name}@example.test`, password_hash: 'unused', role_id: roleId,
      is_active: formatBoolean(true), must_change_password: formatBoolean(false),
    }).returning('id');
    require('../../src/middleware/permissions').clearPermissionCache();
    return { id: admin.id ?? admin, token: mintAdminToken(admin.id ?? admin) };
  };
  const feedNumber = async ({ token: adminToken }) => {
    const res = await request(dashboardApp).get('/api/admin/dashboard/activity?limit=50')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    // Creating the invoice logged its own entry, which already stores the number.
    return res.body.find(({ type, metadata }) => type === 'invoice_sent' && metadata.invoiceId === invoiceId).metadata.invoiceNumber;
  };

  const withoutBills = await makeAdmin('feed_no_bills', ['analytics.view', 'events.view_all']);
  await db('invoices').where({ id: invoiceId }).update({ created_by_admin_id: withoutBills.id });
  expect(await feedNumber(withoutBills)).toBe(`#${invoiceId}`);

  const withBills = await makeAdmin('feed_bills', ['analytics.view', 'events.view_all', 'bills.view']);
  await db('invoices').where({ id: invoiceId }).update({ created_by_admin_id: withBills.id });
  expect(await feedNumber(withBills)).toBe(invoiceNumber);
});

test('an issued invoice stays locked', async () => {
  const invoiceId = await makeInvoice('sent');

  const saved = await request(invoiceApp).put(`/api/admin/invoices/${invoiceId}`).set(auth).send({
    eventDate: '2026-11-14',
  });
  expect(saved.status).toBe(409);
  expect(saved.body.code).toBe('INVOICE_LOCKED');

  const after = await db('invoices').where({ id: invoiceId }).first();
  expect(toDateOnly(after.event_date)).toBe('2026-10-03');
});
