/**
 * Customer documents in the portal (#1444, migration 225).
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

// Real PDFs, built with pdf-lib. The fixtures used to be hand-written stubs
// that started with `%PDF-` and parsed as nothing: enough for the 20-byte
// magic check this suite was written against, not for the content inspection
// that replaced it (utils/pdfValidation, #1444 slice 1d). `makePdf` is the
// same shape pdfValidation.test.js and contractAttachments.test.js use.
const { PDFDocument, PDFName, PDFString } = require('pdf-lib');

async function makePdf({ pages = 1, mutate } = {}) {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i += 1) doc.addPage([200, 200]);
  if (mutate) mutate(doc);
  return Buffer.from(await doc.save());
}

const ZIP_NAMED_PDF = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0x08, 0x00]);
let PDF;
let ENCRYPTED_PDF;
let SCRIPTED_PDF;

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
  PDF = await makePdf();
  // pdf-lib refuses to LOAD an encrypted document, which is what the check
  // relies on; the same trick pdfValidation.test.js uses to make one.
  ENCRYPTED_PDF = Buffer.from(
    (await makePdf()).toString('latin1').replace('/Root', '/Encrypt 1 0 R\n/Root'), 'latin1',
  );
  SCRIPTED_PDF = await makePdf({
    mutate: (doc) => doc.catalog.set(PDFName.of('OpenAction'), doc.context.obj({
      Type: 'Action', S: 'JavaScript', JS: PDFString.of('app.alert(1)'),
    })),
  });

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
  // 120s is not enough to run the full core-migration set against a
  // containerised PostgreSQL: the boot alone takes ~110s there, and a
  // timeout in this hook fails every test in the file at once.
}, 300000);

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

  it('refuses EVERY admin mutation addressed through the wrong customer (#1444)', async () => {
    // Review was the only one pinned; the rest of the admin surface reaches
    // the same document by id, and each one had to be checked on its own.
    const wrong = (path, method = 'post') => asAdmin(request(adminApp)[method](
      `/api/admin/customers/${customerB}/documents/${pendingId}${path}`,
    ));
    const before = await db('customer_documents').where({ id: pendingId }).first();

    expect((await wrong('/share')).status).toBe(404);
    expect((await wrong('/unshare')).status).toBe(404);
    expect((await wrong('/download', 'get')).status).toBe(404);
    expect((await wrong('', 'delete')).status).toBe(404);
    expect((await wrong('', 'patch').send({ eventId: null }))).toMatchObject({ status: 404 });

    // A 404 that changed something is not a refusal.
    const after = await db('customer_documents').where({ id: pendingId }).first();
    expect({
      status: after.status, shared_at: after.shared_at, unshared_at: after.unshared_at,
      deleted_at: after.deleted_at, event_id: after.event_id,
    }).toEqual({
      status: before.status, shared_at: before.shared_at, unshared_at: before.unshared_at,
      deleted_at: before.deleted_at, event_id: before.event_id,
    });
  });

  it('refuses an upload linked to another customer\'s contract or project', async () => {
    // resolveLinks checks ownership, and answers 400 rather than telling the
    // caller whether the record exists.
    const foreignContract = idOf(await db('contracts').insert({
      contract_number: `K-X-${Date.now()}`, customer_account_id: customerB, title: 'Theirs',
      status: 'draft', language: 'de', issue_date: new Date().toISOString().slice(0, 10),
      created_at: new Date().toISOString(),
    }).returning('id'));

    const res = await uploadAs(customerA, PDF, 'linked.pdf', { contractId: foreignContract });
    expect(res.status).toBe(400);
    expect(await db('customer_documents').where({ contract_id: foreignContract }).first()).toBeUndefined();
    expect(tempFiles()).toHaveLength(0);

    // A project is admin-only on the way in; a customer naming one is
    // ignored rather than trusted.
    const ok = await uploadAs(customerA, PDF, 'noproject.pdf', { projectId: 999999 });
    expect(ok.status).toBe(201);
    expect((await db('customer_documents').where({ id: ok.body.document.id }).first()).project_id).toBeNull();

    await db('contracts').where({ id: foreignContract }).del();
  });

  it('shuts a deactivated customer out of every document route', async () => {
    // B's own clean document, downloadable while B is active: deactivation is
    // then the only reason left for a refusal. Another customer's id would be
    // refused with 404 anyway, so it could not tell the two apart.
    const own = await uploadAs(customerB, PDF, 'own-before-off.pdf');
    expect(own.status).toBe(201);
    const ownId = own.body.document.id;
    expect((await asAdmin(request(adminApp)
      .post(`/api/admin/customers/${customerB}/documents/${ownId}/review`)).send({ status: 'clean' })).status).toBe(200);
    const ownUrl = `/api/customer/documents/${ownId}/download`;
    expect((await asCustomer(request(customerApp).get(ownUrl), customerB)).status).toBe(200);

    await db('customer_accounts').where({ id: customerB }).update({ is_active: 0 });
    try {
      // customerAuth re-reads the account on every request and treats an
      // inactive one as gone.
      const refused = (res) => {
        expect(res.status).toBe(401);
        expect(res.body.code).toBe('CUSTOMER_NOT_FOUND');
      };
      refused(await asCustomer(request(customerApp).get('/api/customer/documents'), customerB));
      refused(await uploadAs(customerB, PDF, 'while-off.pdf'));
      refused(await asCustomer(request(customerApp).get(ownUrl), customerB));
    } finally {
      await db('customer_accounts').where({ id: customerB }).update({ is_active: 1 });
      await db('customer_documents').where({ id: ownId }).update({ deleted_at: new Date().toISOString() });
    }
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

  it('counts the quota where the row is written, so parallel uploads can\'t both fit', async () => {
    // The route's own check runs before the body arrives, so two uploads
    // landing together both measured the same "before" and both fitted.
    const used = await require('../../src/services/customerDocumentsService').getUsageBytes(customerA);
    const quotaMb = (used + PDF.length * 1.5) / (1024 * 1024);
    await db('app_settings').where({ setting_key: 'customer_documents_quota_mb' })
      .update({ setting_value: JSON.stringify(quotaMb) });

    const both = await Promise.all([
      uploadAs(customerA, PDF, 'race-1.pdf'),
      uploadAs(customerA, PDF, 'race-2.pdf'),
    ]);
    const statuses = both.map((r) => r.status).sort();
    expect(statuses[0]).toBe(201);
    expect(statuses[1]).toBe(413);
    expect(await require('../../src/services/customerDocumentsService').getUsageBytes(customerA))
      .toBeLessThanOrEqual(Math.ceil(quotaMb * 1024 * 1024));

    await db('app_settings').where({ setting_key: 'customer_documents_quota_mb' })
      .update({ setting_value: JSON.stringify(250) });
  });

  // -------------------------------------------------------------------
  // Slice 1 of the #1444 plan — hardening what shipped
  // -------------------------------------------------------------------

  it('refuses a PDF carrying active content, by its contents (#1444)', async () => {
    // The old check read the first 20 bytes and searched for `/Encrypt`; a
    // PDF that opens a JavaScript action passed both.
    const before = tempFiles().length;
    const res = await uploadAs(customerA, SCRIPTED_PDF, 'signed.pdf');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('PDF_ACTIVE_CONTENT');
    expect(tempFiles().length).toBe(before);
  });

  it('still accepts a PDF with a form, which is what a signed contract is', async () => {
    // pdfInspect refuses actions that run, submit or import — not the
    // presence of a form. A customer uploading a digitally signed contract
    // is uploading an AcroForm with a signature field.
    const withForm = await makePdf({
      mutate: (doc) => doc.catalog.set(PDFName.of('AcroForm'), doc.context.obj({
        Fields: [], SigFlags: 3,
      })),
    });
    const res = await uploadAs(customerA, withForm, 'signed-contract.pdf');
    expect(res.status).toBe(201);
    // And the bytes on disk are the ones the customer uploaded, not a
    // re-serialisation: rewriting the file would break the byte ranges a
    // digital signature covers.
    const row = await db('customer_documents').where({ id: res.body.document.id }).first();
    expect(fs.readFileSync(path.join(process.env.STORAGE_PATH, row.storage_key)).equals(withForm)).toBe(true);
  });

  it('a registered scanner gates an admin upload too', async () => {
    // An admin upload was stored `clean` whatever the scanner said, so a
    // scanner that was down or answered `pending` let it through unscanned
    // and shareable — the one case a scanner exists for.
    const documentScanService = require('../../src/services/documentScanService');
    documentScanService.registerScanner(async () => { throw new Error('scanner down'); });
    try {
      const res = await asAdmin(request(adminApp).post(`/api/admin/customers/${customerA}/documents`))
        .attach('file', PDF, { filename: 'from-admin.pdf', contentType: 'application/pdf' });
      expect(res.status).toBe(201);
      expect(res.body.document.status).toBe('pending');

      // A share asked for with the upload is not recorded while the scanner
      // has it pending: setShared would refuse it, so create must as well.
      const withShare = await asAdmin(request(adminApp).post(`/api/admin/customers/${customerA}/documents`))
        .field('share', 'true')
        .attach('file', PDF, { filename: 'from-admin-shared.pdf', contentType: 'application/pdf' });
      expect(withShare.status).toBe(201);
      expect(withShare.body.document.status).toBe('pending');
      const stored = await db('customer_documents').where({ id: withShare.body.document.id }).first();
      expect(stored.shared_at).toBeFalsy();

      // …and a pending document cannot be shared.
      const share = await asAdmin(
        request(adminApp).post(`/api/admin/customers/${customerA}/documents/${res.body.document.id}/share`),
      ).send({ shared: true });
      expect(share.status).toBe(409);
      expect(share.body.code).toBe('DOCUMENT_NOT_CLEAN');
    } finally {
      documentScanService.registerScanner(null);
    }
  });

  it('with no scanner an admin upload is still vouched for by the admin', async () => {
    const res = await asAdmin(request(adminApp).post(`/api/admin/customers/${customerA}/documents`))
      .attach('file', PDF, { filename: 'vouched.pdf', contentType: 'application/pdf' });
    expect(res.status).toBe(201);
    expect(res.body.document.status).toBe('clean');
  });

  it('refuses to delete a contract-linked document, and the sweep leaves it alone', async () => {
    const { runCustomerDocumentRetention } = require('../../src/services/customerDocumentRetentionService');
    // A draft, and removed again at the end: a `sent` contract left behind
    // shows up in the portal dashboard's "needs action" and would fail the
    // suite's later expectations on it.
    const contractId = idOf(await db('contracts').insert({
      contract_number: `K-DOC-${Date.now()}`, customer_account_id: customerA, title: 'Linked',
      status: 'draft', language: 'de', issue_date: new Date().toISOString().slice(0, 10),
      created_at: new Date().toISOString(),
    }).returning('id'));

    const up = await asAdmin(request(adminApp).post(`/api/admin/customers/${customerA}/documents`))
      .field('contractId', String(contractId))
      .attach('file', PDF, { filename: 'agreement.pdf', contentType: 'application/pdf' });
    expect(up.status).toBe(201);
    const id = up.body.document.id;

    const del = await asAdmin(request(adminApp).delete(`/api/admin/customers/${customerA}/documents/${id}`));
    expect(del.status).toBe(409);
    expect(del.body.code).toBe('DOCUMENT_CONTRACT_LINKED');
    expect((await db('customer_documents').where({ id }).first()).deleted_at).toBeFalsy();

    // Even a row that somehow reaches the sweep deleted keeps its bytes
    // while the contract link stands.
    const stamp = new Date(Date.now() - 90 * 864e5).toISOString();
    await db('customer_documents').where({ id }).update({ deleted_at: stamp });
    const row = await db('customer_documents').where({ id }).first();
    await runCustomerDocumentRetention(Date.now());
    expect((await db('customer_documents').where({ id }).first()).purged_at).toBeFalsy();
    expect(fs.existsSync(path.join(process.env.STORAGE_PATH, row.storage_key))).toBe(true);

    // Unlinking is the deliberate path, and then it deletes.
    await db('customer_documents').where({ id }).update({ deleted_at: null, contract_id: null });
    expect((await asAdmin(request(adminApp).delete(`/api/admin/customers/${customerA}/documents/${id}`))).status).toBe(200);
    await db('contracts').where({ id: contractId }).del();
  });

  it('the sweep does not delete a rejected document linked to a contract after it was selected', async () => {
    const { runCustomerDocumentRetention } = require('../../src/services/customerDocumentRetentionService');
    const contractId = idOf(await db('contracts').insert({
      contract_number: `K-RACE-${Date.now()}`, customer_account_id: customerA, title: 'Race',
      status: 'draft', language: 'de', issue_date: new Date().toISOString().slice(0, 10),
      created_at: new Date().toISOString(),
    }).returning('id'));
    const up = await asAdmin(request(adminApp).post(`/api/admin/customers/${customerA}/documents`))
      .attach('file', PDF, { filename: 'late-link.pdf', contentType: 'application/pdf' });
    expect(up.status).toBe(201);
    const id = up.body.document.id;
    await db('customer_documents').where({ id }).update({
      status: 'rejected', reviewed_at: new Date(Date.now() - 90 * 864e5).toISOString(),
    });

    // The link lands between the sweep's select and its update: it is queued
    // on the (single) SQLite connection the moment the select is issued.
    let link = null;
    const onQuery = (q) => {
      if (!link && /^select/i.test(q.sql) && q.sql.includes('reviewed_at')) {
        // .then() starts it now; a knex builder is lazy until then.
        link = db('customer_documents').where({ id }).update({ contract_id: contractId }).then(() => {});
      }
    };
    db.on('query', onQuery);
    try {
      await runCustomerDocumentRetention(Date.now());
    } finally {
      db.removeListener('query', onQuery);
    }
    await link;
    const after = await db('customer_documents').where({ id }).first();
    expect(Number(after.contract_id)).toBe(Number(contractId));
    expect(after.deleted_at).toBeFalsy();

    await db('customer_documents').where({ id }).update({ contract_id: null, deleted_at: new Date().toISOString() });
    await db('contracts').where({ id: contractId }).del();
  });

  it('purging keeps the bytes of a row linked to a contract since the sweep read it', async () => {
    const customerDocumentsService = require('../../src/services/customerDocumentsService');
    const contractId = idOf(await db('contracts').insert({
      contract_number: `K-PURGE-${Date.now()}`, customer_account_id: customerA, title: 'Purge race',
      status: 'draft', language: 'de', issue_date: new Date().toISOString().slice(0, 10),
      created_at: new Date().toISOString(),
    }).returning('id'));
    const up = await asAdmin(request(adminApp).post(`/api/admin/customers/${customerA}/documents`))
      .attach('file', PDF, { filename: 'purge-race.pdf', contentType: 'application/pdf' });
    expect(up.status).toBe(201);
    const id = up.body.document.id;
    await db('customer_documents').where({ id }).update({ deleted_at: new Date(Date.now() - 90 * 864e5).toISOString() });
    // The snapshot the sweep took, then the link that landed after it.
    const snapshot = await db('customer_documents').where({ id }).first('id', 'storage_key', 'deleted_at');
    await db('customer_documents').where({ id }).update({ contract_id: contractId });

    await customerDocumentsService.purgeFiles([snapshot]);
    expect((await db('customer_documents').where({ id }).first()).purged_at).toBeFalsy();
    expect(fs.existsSync(path.join(process.env.STORAGE_PATH, snapshot.storage_key))).toBe(true);

    await db('customer_documents').where({ id }).update({ contract_id: null });
    await db('contracts').where({ id: contractId }).del();
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

  it('keeps a contract-linked document as evidence, without the customer\'s file name', async () => {
    // The bytes and the storage key are what the contractual record needs.
    // The name the customer chose ("Scan_Anna_Muster_Pass.pdf") is their data
    // too, so erasure has to reach it even on the rows that are kept.
    const customerC = idOf(await db('customer_accounts').insert({
      email: 'erase-c@example.com', display_name: 'Carla', password_hash: 'x',
      preferred_language: 'de', is_active: 1, created_at: new Date().toISOString(),
    }).returning('id'));
    await db('customer_accounts').where({ id: customerC }).update({ feature_documents: true });
    const contractId = idOf(await db('contracts').insert({
      contract_number: 'K-ERASE-1', customer_account_id: customerC, status: 'sent', issue_date: '2026-09-01',
    }).returning('id'));
    const res = await asAdmin(request(adminApp).post(`/api/admin/customers/${customerC}/documents`))
      .field('contractId', String(contractId))
      .attach('file', PDF, { filename: 'Scan_Pass.pdf', contentType: 'application/pdf' });
    expect(res.status).toBe(201);
    const row = await db('customer_documents').where({ id: res.body.document.id }).first();
    expect(row.contract_id).toBe(contractId);
    await db('customer_documents').where({ id: row.id }).update({ shared_at: new Date().toISOString() });

    await require('../../src/services/customerAccountsService').eraseCustomer(customerC, null);

    const after = await db('customer_documents').where({ id: row.id }).first();
    expect(after.original_name).toBe('erased.pdf');
    expect(after.purged_at).toBeFalsy();
    expect(after.unshared_at).toBeTruthy();
    expect(fs.existsSync(path.join(process.env.STORAGE_PATH, row.storage_key))).toBe(true);
  });
});
