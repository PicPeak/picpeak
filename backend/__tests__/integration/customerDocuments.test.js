/**
 * Customer documents in the portal (#1444, migration 220).
 *
 * Pins the access rules end to end through the real routers:
 *  - global flag and per-customer override, on both surfaces
 *  - PDF decided by content, size / quota limits
 *  - pending and rejected uploads are never downloadable by the customer
 *  - every lookup is scoped to the owning customer (list, download, admin
 *    routes addressed through another customer's id)
 *  - share / unshare / soft delete take effect at once
 *  - dashboard and event page return only the caller's records
 *  - erase and the retention sweep remove the bytes
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'crm-route-test-secret';

const fs = require('fs');
const path = require('path');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const { randomUUID } = require('crypto');
const {
  bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken, buildRouteApp,
} = require('./helpers/crmDb');

const PDF = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n');
const ZIP_NAMED_PDF = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0x08, 0x00]);
const ENCRYPTED_PDF = Buffer.from('%PDF-1.7\n1 0 obj << >> endobj\ntrailer << /Root 1 0 R /Encrypt 5 0 R >>\n%%EOF\n');

const binary = (res, cb) => {
  const chunks = [];
  res.on('data', (c) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};

let db;
let cleanup;
let customerApp;
let adminApp;
let superTok;
let limitedTok;
let customerA;
let customerB;
let eventA;
let eventB;
const slugA = 'docs-event-a';
const slugExpired = 'docs-event-expired';
const slugB = 'docs-event-b';

const cookieFor = (customerId) => `customer_token=${jwt.sign(
  { type: 'customer', customerId, jti: randomUUID() },
  process.env.JWT_SECRET,
  { issuer: 'picpeak-auth' },
)}`;
const asCustomer = (req, id) => req.set('Cookie', cookieFor(id));
const asAdmin = (req, tok = superTok) => req.set('Authorization', `Bearer ${tok}`);
const idOf = (inserted) => (typeof inserted[0] === 'object' ? inserted[0].id : inserted[0]);

async function insertEvent(slug, { createdBy, expiresInDays }) {
  const ins = await db('events').insert({
    slug, event_type: 'wedding', event_name: `Event ${slug}`, event_date: '2026-08-01',
    host_email: 'h@example.com', admin_email: 'a@example.com', password_hash: 'x',
    share_link: `/gallery/${slug}`, share_token: `tok-${slug}`,
    expires_at: new Date(Date.now() + expiresInDays * 864e5).toISOString(),
    is_active: 1, is_archived: 0, is_draft: 0, created_by: createdBy,
    created_at: new Date().toISOString(),
  }).returning('id');
  return idOf(ins);
}

async function setFlag(key, on) {
  await db('feature_flags').where({ key }).update({ value: on ? 1 : 0 });
  require('../../src/middleware/requireFeatureFlag').invalidateFeatureFlagCache();
}

function uploadAs(customerId, buffer, filename = 'contract.pdf', fields = {}) {
  let req = asCustomer(request(customerApp).post('/api/customer/documents'), customerId);
  for (const [k, v] of Object.entries(fields)) req = req.field(k, String(v));
  return req.attach('file', buffer, { filename, contentType: 'application/pdf' });
}

const tempDir = () => path.join(process.env.STORAGE_PATH, 'temp', 'customer-documents');
const tempFiles = () => (fs.existsSync(tempDir()) ? fs.readdirSync(tempDir()) : []);

beforeAll(async () => {
  ({ db, cleanup } = await bootCrmDb());
  let adminId;
  ({ adminId, customerId: customerA } = await seedMinimal(db));
  await assignAdminRole(db, adminId, 'super_admin');
  superTok = mintAdminToken(adminId);

  const hash = await bcrypt.hash('x', 4);
  customerB = idOf(await db('customer_accounts').insert({
    email: 'other@example.com', display_name: 'Other', password_hash: hash,
    preferred_language: 'en', is_active: 1, created_at: new Date(),
  }).returning('id'));

  // A role that exists but was not granted the new permission.
  const role = await db('roles').whereNotIn('name', ['super_admin', 'admin']).first();
  const limitedId = idOf(await db('admin_users').insert({
    username: 'limited', email: 'limited@example.com', password_hash: hash,
    must_change_password: false, created_at: new Date(), role_id: role.id,
  }).returning('id'));
  limitedTok = mintAdminToken(limitedId);

  eventA = await insertEvent(slugA, { createdBy: adminId, expiresInDays: 30 });
  const expiredA = await insertEvent(slugExpired, { createdBy: adminId, expiresInDays: -2 });
  eventB = await insertEvent(slugB, { createdBy: adminId, expiresInDays: 30 });
  await db('event_customer_assignments').insert([
    { event_id: eventA, customer_account_id: customerA },
    { event_id: expiredA, customer_account_id: customerA },
    { event_id: eventB, customer_account_id: customerB },
  ]);

  customerApp = buildRouteApp('/api/customer', require('../../src/routes/customer'));
  adminApp = buildRouteApp('/api/admin/customers', require('../../src/routes/adminCustomers'));
}, 120000);

afterAll(async () => {
  if (cleanup) await cleanup();
});

describe('fileSecurityUtils PDF entry', () => {
  const { validateFileType } = require('../../src/utils/fileSecurityUtils');

  it('accepts a PDF only where the caller allows application/pdf', () => {
    expect(validateFileType('a.pdf', 'application/pdf', ['application/pdf'])).toBe(true);
    expect(validateFileType('a.pdf', 'application/pdf', ['image/jpeg', 'image/png'])).toBe(false);
    expect(validateFileType('a.jpg', 'application/pdf', ['application/pdf'])).toBe(false);
    expect(validateFileType('a.jpg', 'image/jpeg', ['image/jpeg'])).toBe(true);
  });
});

describe('with the documents flag off', () => {
  it('refuses the portal routes', async () => {
    const res = await asCustomer(request(customerApp).get('/api/customer/documents'), customerA);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('CUSTOMER_FEATURE_DISABLED');
  });

  it('refuses the admin routes', async () => {
    const res = await asAdmin(request(adminApp).get(`/api/admin/customers/${customerA}/documents`));
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('DOCUMENTS_DISABLED');
  });
});

describe('with the documents flag on', () => {
  let pendingId;
  let sharedId;

  beforeAll(async () => {
    await setFlag('documents', true);
  });

  it('refuses a customer whose own documents feature is off', async () => {
    await db('customer_accounts').where({ id: customerB }).update({ feature_documents: 0 });
    const res = await asCustomer(request(customerApp).get('/api/customer/documents'), customerB);
    expect(res.status).toBe(403);
    await db('customer_accounts').where({ id: customerB }).update({ feature_documents: 1 });
  });

  it('stores a customer PDF under a generated key and keeps it pending', async () => {
    const res = await uploadAs(customerA, PDF, '../../Vertrag Müller.pdf');
    expect(res.status).toBe(201);
    expect(res.body.document).toMatchObject({ status: 'pending', downloadable: false, uploadedBy: 'you' });
    pendingId = res.body.document.id;

    const row = await db('customer_documents').where({ id: pendingId }).first();
    expect(row.storage_key).toMatch(new RegExp(`^business-docs/customer-documents/${customerA}/[0-9a-f-]{36}\\.pdf$`));
    expect(row.original_name).toBe('Vertrag Müller.pdf');
    expect(fs.existsSync(path.join(process.env.STORAGE_PATH, row.storage_key))).toBe(true);
    expect(tempFiles()).toEqual([]);
  });

  it('rejects a non-PDF named .pdf by its content and leaves nothing behind', async () => {
    const before = await db('customer_documents').count({ c: '*' }).first();
    const res = await uploadAs(customerA, ZIP_NAMED_PDF, 'photos.pdf');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('NOT_A_PDF');
    const after = await db('customer_documents').count({ c: '*' }).first();
    expect(Number(after.c)).toBe(Number(before.c));
    expect(tempFiles()).toEqual([]);
  });

  it('rejects a file whose name is not .pdf before it is written', async () => {
    const res = await uploadAs(customerA, PDF, 'contract.html');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('NOT_A_PDF');
  });

  it('rejects a password-protected PDF', async () => {
    const res = await uploadAs(customerA, ENCRYPTED_PDF, 'locked.pdf');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('PDF_ENCRYPTED');
  });

  it('does not let the customer download a pending upload', async () => {
    const res = await asCustomer(request(customerApp).get(`/api/customer/documents/${pendingId}/download`), customerA);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('DOCUMENT_PENDING_REVIEW');
  });

  it('keeps customer A\'s documents away from customer B', async () => {
    const list = await asCustomer(request(customerApp).get('/api/customer/documents'), customerB);
    expect(list.status).toBe(200);
    expect(list.body.documents).toEqual([]);
    const dl = await asCustomer(request(customerApp).get(`/api/customer/documents/${pendingId}/download`), customerB);
    expect(dl.status).toBe(404);
  });

  it('refuses a customer link to an event of another customer', async () => {
    const res = await uploadAs(customerA, PDF, 'x.pdf', { eventId: eventB });
    expect(res.status).toBe(400);
  });

  it('requires customers.documents.manage on the admin routes', async () => {
    const noToken = await request(adminApp).get(`/api/admin/customers/${customerA}/documents`);
    expect(noToken.status).toBe(401);
    const limited = await asAdmin(request(adminApp).get(`/api/admin/customers/${customerA}/documents`), limitedTok);
    expect(limited.status).toBe(403);
    const review = await asAdmin(request(adminApp)
      .post(`/api/admin/customers/${customerA}/documents/${pendingId}/review`), limitedTok)
      .send({ status: 'clean' });
    expect(review.status).toBe(403);
  });

  it('does not reach customer A\'s document through customer B\'s id', async () => {
    const res = await asAdmin(request(adminApp)
      .post(`/api/admin/customers/${customerB}/documents/${pendingId}/review`)).send({ status: 'clean' });
    expect(res.status).toBe(404);
    const row = await db('customer_documents').where({ id: pendingId }).first();
    expect(row.status).toBe('pending');
  });

  it('lets the customer download once an admin marked it clean, as an attachment', async () => {
    const review = await asAdmin(request(adminApp)
      .post(`/api/admin/customers/${customerA}/documents/${pendingId}/review`)).send({ status: 'clean' });
    expect(review.status).toBe(200);

    const res = await asCustomer(request(customerApp).get(`/api/customer/documents/${pendingId}/download`), customerA)
      .buffer(true).parse(binary);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/pdf/);
    expect(res.headers['content-disposition']).toMatch(/^attachment;/);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(Buffer.compare(res.body, PDF)).toBe(0);

    const admin = await asAdmin(request(adminApp).get(`/api/admin/customers/${customerA}/documents`));
    const doc = admin.body.documents.find((d) => d.id === pendingId);
    expect(doc.customerViewCount).toBe(1);
  });

  it('shows a rejected upload with its reason and keeps it undownloadable', async () => {
    const up = await uploadAs(customerA, PDF, 'wrong.pdf');
    const id = up.body.document.id;
    await asAdmin(request(adminApp).post(`/api/admin/customers/${customerA}/documents/${id}/review`))
      .send({ status: 'rejected', note: 'Wrong contract version' });
    const list = await asCustomer(request(customerApp).get('/api/customer/documents'), customerA);
    expect(list.body.documents.find((d) => d.id === id)).toMatchObject({
      status: 'rejected', rejectionReason: 'Wrong contract version', downloadable: false,
    });
    const dl = await asCustomer(request(customerApp).get(`/api/customer/documents/${id}/download`), customerA);
    expect(dl.status).toBe(409);
    expect(dl.body.code).toBe('DOCUMENT_REJECTED');
  });

  it('shares an admin upload with customer A only', async () => {
    const res = await asAdmin(request(adminApp).post(`/api/admin/customers/${customerA}/documents`))
      .field('share', 'true')
      .field('eventId', String(eventA))
      .attach('file', PDF, { filename: 'Offer.pdf', contentType: 'application/pdf' });
    expect(res.status).toBe(201);
    expect(res.body.document.status).toBe('clean');
    sharedId = res.body.document.id;

    const listA = await asCustomer(request(customerApp).get('/api/customer/documents'), customerA);
    expect(listA.body.documents.find((d) => d.id === sharedId)).toMatchObject({ uploadedBy: 'studio', eventId: eventA });
    const dlB = await asCustomer(request(customerApp).get(`/api/customer/documents/${sharedId}/download`), customerB);
    expect(dlB.status).toBe(404);
  });

  it('hides a document from the customer as soon as it is unshared', async () => {
    const res = await asAdmin(request(adminApp).post(`/api/admin/customers/${customerA}/documents/${sharedId}/unshare`));
    expect(res.status).toBe(200);
    const list = await asCustomer(request(customerApp).get('/api/customer/documents'), customerA);
    expect(list.body.documents.find((d) => d.id === sharedId)).toBeUndefined();
    const dl = await asCustomer(request(customerApp).get(`/api/customer/documents/${sharedId}/download`), customerA);
    expect(dl.status).toBe(404);
    await asAdmin(request(adminApp).post(`/api/admin/customers/${customerA}/documents/${sharedId}/share`));
  });

  it('shows the event\'s documents on the event page, and 404s the page for others', async () => {
    const own = await asCustomer(request(customerApp).get(`/api/customer/events/${slugA}/overview`), customerA);
    expect(own.status).toBe(200);
    expect(own.body.event).toMatchObject({ slug: slugA, availability: 'active' });
    expect(own.body.documents.map((d) => d.id)).toEqual([sharedId]);
    const other = await asCustomer(request(customerApp).get(`/api/customer/events/${slugA}/overview`), customerB);
    expect(other.status).toBe(404);
  });

  it('soft-deletes: gone from both lists and not downloadable', async () => {
    const res = await asAdmin(request(adminApp).delete(`/api/admin/customers/${customerA}/documents/${sharedId}`));
    expect(res.status).toBe(200);
    const admin = await asAdmin(request(adminApp).get(`/api/admin/customers/${customerA}/documents`));
    expect(admin.body.documents.find((d) => d.id === sharedId)).toBeUndefined();
    const list = await asCustomer(request(customerApp).get('/api/customer/documents'), customerA);
    expect(list.body.documents.find((d) => d.id === sharedId)).toBeUndefined();
    const dl = await asCustomer(request(customerApp).get(`/api/customer/documents/${sharedId}/download`), customerA);
    expect(dl.status).toBe(404);
    const row = await db('customer_documents').where({ id: sharedId }).first();
    expect(row.deleted_at).toBeTruthy();
  });

  it('refuses an upload once the quota is used up', async () => {
    await db('app_settings').where({ setting_key: 'customer_documents_quota_mb' })
      .update({ setting_value: JSON.stringify(0.00001) });
    const res = await uploadAs(customerA, PDF, 'more.pdf');
    expect(res.status).toBe(413);
    expect(res.body.code).toBe('QUOTA_EXCEEDED');
    await db('app_settings').where({ setting_key: 'customer_documents_quota_mb' })
      .update({ setting_value: JSON.stringify(250) });
  });

  it('removes the bytes of a deleted document once retention has passed', async () => {
    const { runCustomerDocumentRetention } = require('../../src/services/customerDocumentRetentionService');
    const row = await db('customer_documents').where({ id: sharedId }).first();
    await runCustomerDocumentRetention(Date.now() + 31 * 864e5);
    const after = await db('customer_documents').where({ id: sharedId }).first();
    expect(after.purged_at).toBeTruthy();
    expect(fs.existsSync(path.join(process.env.STORAGE_PATH, row.storage_key))).toBe(false);
  });
});

describe('portal dashboard', () => {
  beforeAll(async () => {
    for (const key of ['quotes', 'bills', 'contracts']) await setFlag(key, true);
    // Migration 092 seeds the customer-surface quotes / bills globals off.
    await db('app_settings')
      .whereIn('setting_key', ['customer_feature_quotes_enabled', 'customer_feature_bills_enabled'])
      .update({ setting_value: JSON.stringify(true) });
    await db('customer_accounts').whereIn('id', [customerA, customerB])
      .update({ feature_quotes: 1, feature_bills: 1, feature_contracts: 1 });
    for (const [customer, suffix] of [[customerA, 'A'], [customerB, 'B']]) {
      await db('quotes').insert({
        quote_number: `Q-${suffix}`, customer_account_id: customer, status: 'sent', issue_date: '2026-09-01',
      });
      await db('contracts').insert({
        contract_number: `C-${suffix}`, customer_account_id: customer, status: 'sent', issue_date: '2026-09-01',
      });
      await db('invoices').insert({
        invoice_number: `I-${suffix}`, customer_account_id: customer, status: 'sent',
        issue_date: '2026-08-01', due_date: '2026-08-15',
      });
    }
  });

  it('returns only the caller\'s items and splits active from expired galleries', async () => {
    const res = await asCustomer(request(customerApp).get('/api/customer/dashboard'), customerA);
    expect(res.status).toBe(200);
    expect(res.body.needsAction.quotes.map((q) => q.quoteNumber)).toEqual(['Q-A']);
    expect(res.body.needsAction.contracts.map((c) => c.contractNumber)).toEqual(['C-A']);
    expect(res.body.needsAction.invoices.map((i) => i.invoiceNumber)).toEqual(['I-A']);
    expect(res.body.needsAction.invoices[0].overdue).toBe(true);
    expect(res.body.galleries.active.map((e) => e.slug)).toEqual([slugA]);
    expect(res.body.galleries.expired.map((e) => e.slug)).toEqual([slugExpired]);
    expect(res.body.galleries.expired[0].expiresAt).toBeTruthy();
  });
});

describe('customer erasure', () => {
  it('deletes the customer\'s unlinked documents and their files', async () => {
    const res = await asAdmin(request(adminApp).post(`/api/admin/customers/${customerB}/documents`))
      .attach('file', PDF, { filename: 'b.pdf', contentType: 'application/pdf' });
    expect(res.status).toBe(201);
    const row = await db('customer_documents').where({ id: res.body.document.id }).first();

    await require('../../src/services/customerAccountsService').eraseCustomer(customerB, null);

    const after = await db('customer_documents').where({ id: row.id }).first();
    expect(after.deleted_at).toBeTruthy();
    expect(after.purged_at).toBeTruthy();
    expect(after.original_name).toBe('erased.pdf');
    expect(fs.existsSync(path.join(process.env.STORAGE_PATH, row.storage_key))).toBe(false);
  });
});
