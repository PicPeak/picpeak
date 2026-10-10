/**
 * A scheduled invoice is edited on its own page. PUT used to drop its VAT
 * code and linked event while the editor said "saved"; they now save, with
 * the checks createInvoice makes: the event must be one the admin owns (the
 * rule CRM code uses for events), and an
 * event with customer assignments must belong to the invoice's customer.
 * Creating an invoice applies the same event rule. The event rule is the one
 * the CRM database layer applies (canLinkCrmToEvent: the gallery's creator or
 * a super admin) — anything looser links an invoice its own author can no
 * longer read. The customer is fixed once
 * the invoice exists (409), because drafts, lineage, installments and
 * re-billed proofs hang off it.
 */

const request = require('supertest');
const {
  bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken, buildRouteApp,
} = require('./helpers/crmDb');

jest.setTimeout(120000);

let db;
let cleanup;
let tmpDir;
let customerId;
let otherCustomerId;
let editorToken;
let ownEventId;
let foreignEventId;
let invoiceApp;

const prevCwd = process.cwd();
const id = (rows) => (typeof rows[0] === 'object' ? rows[0].id : rows[0]);

async function insertEvent(slug, createdBy) {
  return id(await db('events').insert({
    slug,
    event_type: 'wedding',
    event_name: slug,
    event_date: '2026-01-01',
    host_email: 'h@example.com',
    admin_email: 'a@example.com',
    password_hash: 'x',
    share_link: `${slug}-share`,
    expires_at: new Date().toISOString(),
    created_by: createdBy,
  }).returning('id'));
}

beforeAll(async () => {
  ({ db, cleanup, tmpDir } = await bootCrmDb());
  process.chdir(tmpDir);
  let ownerId;
  ({ adminId: ownerId, customerId } = await seedMinimal(db));
  await assignAdminRole(db, ownerId, 'super_admin');

  // The editor holds the built-in `admin` role (bills.manage, events.view_all
  // but not events.manage_all): it may link the galleries it created, not
  // another admin's — the CRM owner rule (canLinkCrmToEvent).
  const editorId = id(await db('admin_users').insert({
    username: 'editor', email: 'editor@example.com', password_hash: 'x',
    must_change_password: false, created_at: new Date(),
  }).returning('id'));
  await assignAdminRole(db, editorId, 'admin');
  editorToken = mintAdminToken(editorId);

  otherCustomerId = id(await db('customer_accounts').insert({
    email: 'second@example.com', display_name: 'Second Customer', password_hash: 'x',
    preferred_language: 'de', is_active: 1, created_at: new Date(),
  }).returning('id'));

  ownEventId = await insertEvent('editor-own', editorId);
  foreignEventId = await insertEvent('someone-elses', ownerId);

  const updated = await db('feature_flags').where({ key: 'bills' }).update({ value: true });
  if (!updated) await db('feature_flags').insert({ key: 'bills', value: true });
  invoiceApp = buildRouteApp('/api/admin/invoices', require('../../src/routes/adminInvoices'));
}, 120000);

afterAll(async () => {
  process.chdir(prevCwd);
  if (cleanup) await cleanup();
});

const as = (req) => req.set('Authorization', `Bearer ${editorToken}`);

async function scheduledInvoice() {
  const created = await as(request(invoiceApp).post('/api/admin/invoices')).send({
    customerAccountId: customerId, currency: 'CHF', vatRate: 0,
    lineItems: [{ position: 1, quantity: 1, description: 'Shooting', unitPriceMinor: 100000, discountPercent: 0 }],
  });
  expect(created.status).toBe(201);
  return created.body.invoice.id;
}

test('VAT code and an owned event save on a scheduled invoice', async () => {
  const invoiceId = await scheduledInvoice();
  const saved = await as(request(invoiceApp).put(`/api/admin/invoices/${invoiceId}`)).send({
    customerAccountId: customerId, vatCode: 'UN81', vatRate: 8.1, eventId: ownEventId,
  });
  expect(saved.status).toBe(200);
  const row = await db('invoices').where({ id: invoiceId }).first();
  expect(Number(row.event_id)).toBe(ownEventId);
  expect(row.vat_code).toBe('UN81');
});

test('the customer of an existing invoice is not changed', async () => {
  const invoiceId = await scheduledInvoice();
  const moved = await as(request(invoiceApp).put(`/api/admin/invoices/${invoiceId}`)).send({ customerAccountId: otherCustomerId });
  expect(moved.status).toBe(409);
  expect(moved.body.code).toBe('INVOICE_CUSTOMER_LOCKED');
  expect(Number((await db('invoices').where({ id: invoiceId }).first()).customer_account_id)).toBe(customerId);
});

test('the built-in admin role cannot link another admin\'s gallery, on update or on create', async () => {
  const invoiceId = await scheduledInvoice();
  const put = await as(request(invoiceApp).put(`/api/admin/invoices/${invoiceId}`)).send({ eventId: foreignEventId });
  expect(put.status).toBe(403);
  expect((await db('invoices').where({ id: invoiceId }).first()).event_id).toBeNull();

  const post = await as(request(invoiceApp).post('/api/admin/invoices')).send({
    customerAccountId: customerId, currency: 'CHF', vatRate: 0, eventId: foreignEventId,
    lineItems: [{ position: 1, quantity: 1, description: 'Shooting', unitPriceMinor: 100000, discountPercent: 0 }],
  });
  expect(post.status).toBe(403);
});

test('an event assigned to another customer is refused', async () => {
  const invoiceId = await scheduledInvoice();
  await db('event_customer_assignments').insert({ event_id: ownEventId, customer_account_id: otherCustomerId });
  // The invoice is for `customerId`; the event belongs to the other customer.
  const put = await as(request(invoiceApp).put(`/api/admin/invoices/${invoiceId}`)).send({ eventId: ownEventId });
  expect(put.status).toBe(422);
  await db('event_customer_assignments').where({ event_id: ownEventId }).del();
});

test('the VAT code can be cleared back to a custom rate', async () => {
  const invoiceId = await scheduledInvoice();
  await db('invoices').where({ id: invoiceId }).update({ vat_code: 'UN81' });
  const cleared = await as(request(invoiceApp).put(`/api/admin/invoices/${invoiceId}`)).send({ vatCode: null });
  expect(cleared.status).toBe(200);
  expect((await db('invoices').where({ id: invoiceId }).first()).vat_code).toBeNull();
});

test('a gallery without an owner is refused too, as the CRM database rule refuses it', async () => {
  const ownerless = await insertEvent('ownerless', null);
  const invoiceId = await scheduledInvoice();
  const saved = await as(request(invoiceApp).put(`/api/admin/invoices/${invoiceId}`)).send({ eventId: ownerless });
  expect(saved.status).toBe(403);
});

test('canLinkCrmToEvent: the creator or a super admin, nobody else', () => {
  const { canLinkCrmToEvent } = require('../../src/middleware/ownership');
  expect(canLinkCrmToEvent({ id: 5, roleName: 'admin' }, { created_by: 5 })).toBe(true);
  expect(canLinkCrmToEvent({ id: 5, roleName: 'admin' }, { created_by: 6 })).toBe(false);
  expect(canLinkCrmToEvent({ id: 5, roleName: 'admin' }, { created_by: null })).toBe(false);
  expect(canLinkCrmToEvent({ id: 5, roleName: 'admin', eventScope: { manageAll: true } }, { created_by: 6 })).toBe(false);
  expect(canLinkCrmToEvent({ id: 5, roleName: 'super_admin' }, { created_by: null })).toBe(true);
});
