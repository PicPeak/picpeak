/**
 * Who receives a payment-check link (a link that records a payment without
 * logging in) and the notifications about it.
 *
 * The invoice's creator gets them only while that account may record
 * payments on the invoice: active, and holding bills.manage. Otherwise an
 * active super admin does, else the business address. Each link names the
 * admin it was mailed to and stops working once that admin may no longer
 * record payments here; a link to the business address keeps working. The
 * alert about a recorded action also goes to the business address.
 */

const { bootCrmDb, seedMinimal, assignAdminRole } = require('./helpers/crmDb');

jest.setTimeout(120000);

const formatBoolean = (value) => require('../../src/utils/dbCompat').formatBoolean(value);
const idOf = (inserted) => (typeof inserted[0] === 'object' ? inserted[0].id : inserted[0]);

let db;
let cleanup;
let customerId;
let staffId;
let roleId;
let payments;
let sequence = 0;

async function sentInvoice() {
  sequence += 1;
  return idOf(await db('invoices').insert({
    invoice_number: `PCR-${sequence}`,
    customer_account_id: customerId,
    status: 'sent',
    currency: 'CHF',
    issue_date: '2026-09-01',
    due_date: '2026-09-30',
    total_amount_minor: 25000,
    created_by_admin_id: staffId,
  }).returning('id'));
}

const queuedTo = async (template) => (await db('email_queue').where({ email_type: template }).orderBy('id'))
  .map((r) => r.recipient_email);

beforeAll(async () => {
  ({ db, cleanup } = await bootCrmDb());
  ({ customerId, adminId: staffId } = await seedMinimal(db));
  await db('admin_users').where({ id: staffId }).update({ email: 'staff@example.test', is_active: formatBoolean(true) });
  const [role] = await db('roles').insert({ name: 'payment_check_staff', display_name: 'Staff' }).returning('id');
  roleId = role.id ?? role;
  const manage = await db('permissions').where({ name: 'bills.manage' }).first();
  await db('role_permissions').insert({ role_id: roleId, permission_id: manage.id });
  await db('admin_users').where({ id: staffId }).update({ role_id: roleId });
  await db('business_profile').where({ id: 1 }).update({ email: 'owner@example.test' });
  require('../../src/middleware/permissions').clearPermissionCache();
  payments = require('../../src/services/invoice/payments');
});

afterAll(async () => {
  if (cleanup) await cleanup();
});

beforeEach(async () => {
  await db('email_queue').del();
});

test('the creator gets the link while they may record payments, the business address once they may not', async () => {
  const first = await payments.queuePaymentCheckEmail(await sentInvoice(), { skipThrottle: true });
  expect(first.sent).toBe(true);
  expect(await queuedTo('invoice_payment_check')).toEqual(['staff@example.test']);

  // The role loses bills.manage.
  await db('role_permissions').where({ role_id: roleId }).del();
  require('../../src/middleware/permissions').clearPermissionCache();
  await db('email_queue').del();
  const second = await payments.queuePaymentCheckEmail(await sentInvoice(), { skipThrottle: true });
  expect(second.sent).toBe(true);
  expect(await queuedTo('invoice_payment_check')).toEqual(['owner@example.test']);

  const manage = await db('permissions').where({ name: 'bills.manage' }).first();
  await db('role_permissions').insert({ role_id: roleId, permission_id: manage.id });
  require('../../src/middleware/permissions').clearPermissionCache();
});

test('a link sent before the creator\'s role lost bills.manage stops working', async () => {
  const issued = await payments.queuePaymentCheckEmail(await sentInvoice(), { skipThrottle: true });
  expect(await queuedTo('invoice_payment_check')).toEqual(['staff@example.test']);

  expect(Number((await db('invoice_payment_check_tokens').where({ token: issued.token }).first()).recipient_admin_id))
    .toBe(staffId);
  await db('role_permissions').where({ role_id: roleId }).del();
  require('../../src/middleware/permissions').clearPermissionCache();

  await expect(payments.getPaymentCheckByToken(issued.token)).rejects.toMatchObject({ statusCode: 410 });

  const manage = await db('permissions').where({ name: 'bills.manage' }).first();
  await db('role_permissions').insert({ role_id: roleId, permission_id: manage.id });
  require('../../src/middleware/permissions').clearPermissionCache();
});

test('deactivating the creator retires the link they were sent and moves the next one', async () => {
  const [superRow] = await db('admin_users').insert({
    username: 'studio-owner', email: 'super@example.test', password_hash: 'unused',
    is_active: formatBoolean(true), must_change_password: formatBoolean(false),
  }).returning('id');
  const superId = superRow.id ?? superRow;
  await assignAdminRole(db, superId, 'super_admin');
  require('../../src/middleware/permissions').clearPermissionCache();

  const invoiceId = await sentInvoice();
  const before = await payments.queuePaymentCheckEmail(invoiceId, { skipThrottle: true });
  expect(await queuedTo('invoice_payment_check')).toEqual(['staff@example.test']);

  await require('../../src/services/userManagementService').deactivateAdminUser(staffId, superId);

  await expect(payments.getPaymentCheckByToken(before.token)).rejects.toMatchObject({ statusCode: 410 });
  await expect(payments.recordPaymentCheckAction({ token: before.token, action: 'paid_full' }))
    .rejects.toMatchObject({ statusCode: 410 });
  const stale = await db('invoice_payment_check_tokens').where({ token: before.token }).first();
  expect(stale.used_action).toBe('revoked');
  const untouched = await db('invoices').where({ id: invoiceId }).first();
  expect(untouched.status).toBe('sent');
  expect(Number(untouched.paid_amount_minor || 0)).toBe(0);

  // A link issued after the deactivation goes to an admin who may act on
  // the invoice, works, and the alerts reach that admin and the business.
  await db('email_queue').del();
  const after = await payments.queuePaymentCheckEmail(invoiceId, { skipThrottle: true });
  expect(after.sent).toBe(true);
  expect(await queuedTo('invoice_payment_check')).toEqual(['super@example.test']);
  expect((await payments.getPaymentCheckByToken(after.token)).invoiceNumber).toMatch(/^PCR-/);

  await payments.recordPaymentCheckAction({ token: after.token, action: 'paid_full' });
  expect((await db('invoices').where({ id: invoiceId }).first()).status).toBe('paid');
  expect(await queuedTo('invoice_payment_check_action_recorded')).toEqual(['super@example.test', 'owner@example.test']);
  expect(await queuedTo('invoice_paid_admin_notification')).toEqual(['super@example.test']);
  expect(await queuedTo('invoice_paid_admin_notification')).not.toContain('staff@example.test');
});

test('a link to the super admin stops working once they are deactivated; one to the business address keeps working', async () => {
  // The creator is inactive since the test above: links go to the super admin.
  const superAdmin = await db('admin_users').where({ email: 'super@example.test' }).first();
  const toSuper = await payments.queuePaymentCheckEmail(await sentInvoice(), { skipThrottle: true });
  expect(await queuedTo('invoice_payment_check')).toEqual(['super@example.test']);

  await db('admin_users').where({ id: superAdmin.id }).update({ is_active: formatBoolean(false) });
  await expect(payments.getPaymentCheckByToken(toSuper.token)).rejects.toMatchObject({ statusCode: 410 });

  // No admin qualifies now: the business address gets the link, and it works.
  await db('email_queue').del();
  const toBusiness = await payments.queuePaymentCheckEmail(await sentInvoice(), { skipThrottle: true });
  expect(await queuedTo('invoice_payment_check')).toEqual(['owner@example.test']);
  expect((await db('invoice_payment_check_tokens').where({ token: toBusiness.token }).first()).recipient_admin_id)
    .toBeNull();
  expect((await payments.getPaymentCheckByToken(toBusiness.token)).invoiceNumber).toMatch(/^PCR-/);
});
