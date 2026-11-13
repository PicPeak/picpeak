/**
 * A Storno cancels an issued invoice and is itself immutable: it is sent
 * once and never edited, paid, dunned or sent a payment check. A photographer
 * role (bills.manage, no super-admin) can cancel its own invoice; the Storno
 * then belongs to that admin.
 *
 * Runs through the real admin auth so the CRM row policy applies to the
 * non-super admin, the way it does in production.
 */

const request = require('supertest');
const { bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken, buildRouteApp } = require('./helpers/crmDb');

jest.setTimeout(120000);

const formatBoolean = (value) => require('../../src/utils/dbCompat').formatBoolean(value);

let db;
let cleanup;
let tmpDir;
let app;
let ownerId;
let customerId;
let token;
let invoiceService;
const prevCwd = process.cwd();
const auth = () => ({ Authorization: `Bearer ${token}` });

async function sentInvoice(amount = 100000) {
  const created = await request(app).post('/api/admin/invoices').set(auth()).send({
    customerAccountId: customerId,
    currency: 'CHF',
    vatRate: 0,
    lineItems: [{ position: 1, quantity: 1, description: 'Coverage', unitPriceMinor: amount, discountPercent: 0 }],
  });
  expect(created.status).toBe(201);
  const id = created.body.invoice.id;
  const sent = await request(app).post(`/api/admin/invoices/${id}/send`).set(auth());
  expect(sent.status).toBe(200);
  return id;
}

async function cancelToStorno(id) {
  const res = await request(app).post(`/api/admin/invoices/${id}/cancel`).set(auth());
  expect(res.status).toBe(200);
  const original = await db('invoices').where({ id }).first();
  expect(original.cancellation_storno_id).toBeTruthy();
  return db('invoices').where({ id: original.cancellation_storno_id }).first();
}

beforeAll(async () => {
  ({ db, cleanup, tmpDir } = await bootCrmDb());
  process.chdir(tmpDir);
  ({ adminId: ownerId, customerId } = await seedMinimal(db));
  const [role] = await db('roles').insert({ name: 'storno_lock_test', display_name: 'Storno test photographer' }).returning('id');
  const roleId = role.id ?? role;
  const permissions = await db('permissions').whereIn('name', ['bills.view', 'bills.manage']);
  await db('role_permissions').insert(permissions.map((p) => ({ role_id: roleId, permission_id: p.id })));
  await db('admin_users').where({ id: ownerId }).update({ role_id: roleId, is_active: formatBoolean(true) });
  require('../../src/middleware/permissions').clearPermissionCache();
  await db('feature_flags').where({ key: 'bills' }).update({ value: formatBoolean(true) });
  await db('customer_accounts').where({ id: customerId }).update({ feature_bills: formatBoolean(true) });
  token = mintAdminToken(ownerId);

  const pdfService = require('../../src/services/pdfService');
  pdfService.renderInvoiceToBuffer = async () => Buffer.from('%PDF-1.4 stub');
  invoiceService = require('../../src/services/invoiceService');
  app = buildRouteApp('/api/admin/invoices', require('../../src/routes/adminInvoices'));
});

afterAll(async () => {
  process.chdir(prevCwd);
  if (cleanup) await cleanup();
});

test('a non-super admin cancels its own invoice and owns the Storno', async () => {
  const id = await sentInvoice();
  const storno = await cancelToStorno(id);
  expect(storno.kind).toBe('storno');
  expect(Number(storno.created_by_admin_id)).toBe(ownerId);
});

test('a sent Storno takes no reminder, payment or payment check', async () => {
  const storno = await cancelToStorno(await sentInvoice());
  expect(storno.status).toBe('sent');
  const queuedBefore = await db('email_queue').count('* as n').first();

  const reminder = await request(app).post(`/api/admin/invoices/${storno.id}/send-reminder`).set(auth()).send({ level: 2 });
  expect(reminder.status).toBe(409);
  expect(reminder.body.code).toBe('IS_STORNO');

  const paid = await request(app).post(`/api/admin/invoices/${storno.id}/mark-paid`).set(auth()).send({ amountMinor: 1 });
  expect(paid.status).toBe(409);
  expect(paid.body.code).toBe('IS_STORNO');

  // The scheduler's path into the reminder, and the CAS behind it.
  const data = await invoiceService.getInvoiceById(storno.id);
  await expect(invoiceService.applyReminder(data.invoice, data.lineItems, 2, ownerId))
    .rejects.toMatchObject({ code: 'IS_STORNO' });
  const check = await invoiceService.queuePaymentCheckEmail(storno.id, { skipThrottle: true });
  expect(check).toMatchObject({ sent: false, reason: 'storno' });

  const after = await db('invoices').where({ id: storno.id }).first();
  expect(after.status).toBe('sent');
  expect(Number(after.reminder_level || 0)).toBe(0);
  expect(Number(after.late_fee_amount_minor || 0)).toBe(0);
  expect(Number(after.paid_amount_minor || 0)).toBe(0);
  expect(await db('invoice_payment_log').where({ invoice_id: storno.id }).first()).toBeUndefined();
  expect(await db('invoice_payment_check_tokens').where({ invoice_id: storno.id }).first()).toBeUndefined();
  expect(await db('email_queue').count('* as n').first()).toEqual(queuedBefore);
});

test('a Storno still waiting to be sent cannot be edited or paid', async () => {
  const storno = await cancelToStorno(await sentInvoice());
  // As left behind when its own send was refused.
  await db('invoices').where({ id: storno.id }).update({ status: 'scheduled' });

  const edit = await request(app).put(`/api/admin/invoices/${storno.id}`).set(auth()).send({
    customerAccountId: customerId,
    issueDate: '2025-01-01',
    lineItems: [{ position: 1, quantity: 1, description: 'x', unitPriceMinor: 1, discountPercent: 0 }],
  });
  expect(edit.status).toBe(409);
  expect(edit.body.code).toBe('IS_STORNO');

  const paid = await request(app).post(`/api/admin/invoices/${storno.id}/mark-paid`).set(auth()).send({ amountMinor: 1 });
  expect(paid.status).toBe(409);

  const after = await db('invoices').where({ id: storno.id }).first();
  expect(after.status).toBe('scheduled');
  expect(Number(after.total_amount_minor)).toBe(Number(storno.total_amount_minor));
  expect(String(after.issue_date).slice(0, 10)).not.toBe('2025-01-01');
});

test('a Storno made by a super admin stays with the owner of the invoice it cancels', async () => {
  const id = await sentInvoice();
  const [superRow] = await db('admin_users').insert({
    username: 'storno-super', email: 'storno-super@example.test', password_hash: 'unused',
    is_active: formatBoolean(true), must_change_password: formatBoolean(false),
  }).returning('id');
  const superId = superRow.id ?? superRow;
  await assignAdminRole(db, superId, 'super_admin');
  require('../../src/middleware/permissions').clearPermissionCache();

  const res = await request(app).post(`/api/admin/invoices/${id}/cancel`).set({ Authorization: `Bearer ${mintAdminToken(superId)}` });
  expect(res.status).toBe(200);
  const original = await db('invoices').where({ id }).first();
  const storno = await db('invoices').where({ id: original.cancellation_storno_id }).first();
  expect(Number(storno.created_by_admin_id)).toBe(ownerId);

  // An invoice without an owner keeps an ownerless Storno when a super admin
  // cancels it, so the deal does not move to the super admin.
  const legacyId = await sentInvoice();
  await db('invoices').where({ id: legacyId }).update({ created_by_admin_id: null });
  const legacy = await request(app).post(`/api/admin/invoices/${legacyId}/cancel`).set({ Authorization: `Bearer ${mintAdminToken(superId)}` });
  expect(legacy.status).toBe(200);
  const legacyStorno = await db('invoices')
    .where({ id: (await db('invoices').where({ id: legacyId }).first()).cancellation_storno_id }).first();
  expect(legacyStorno.created_by_admin_id).toBeNull();
});

test('a payment-check link that reached a Storno decides nothing', async () => {
  const storno = await cancelToStorno(await sentInvoice());
  const token = 'c'.repeat(64);
  await db('invoice_payment_check_tokens').insert({
    invoice_id: storno.id, token,
    expires_at: new Date(Date.now() + 3600000).toISOString(), created_at: new Date().toISOString(),
  });
  await expect(invoiceService.getPaymentCheckByToken(token)).rejects.toMatchObject({ statusCode: 409 });
  await expect(invoiceService.recordPaymentCheckAction({ token, action: 'paid_full' }))
    .rejects.toMatchObject({ statusCode: 409 });
  expect((await db('invoice_payment_check_tokens').where({ token }).first()).used_at).toBeNull();
  expect((await db('invoices').where({ id: storno.id }).first()).status).toBe('sent');
});
