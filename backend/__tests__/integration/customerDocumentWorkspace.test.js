/**
 * Customer document workspace (#1444, plan slices 2 onward).
 *
 * The first suite (customerDocuments.test.js) pins what shipped with the
 * document slice. This one pins what was built on top of it: the document
 * page and its distinct states, customers deleting their own uploads, the
 * project link and deal lineage, notifications, activity, abuse signals,
 * the scanner and document requests.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'crm-route-test-secret';

const request = require('supertest');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const { randomUUID } = require('crypto');
const { PDFDocument } = require('pdf-lib');
const {
  bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken, buildRouteApp,
} = require('./helpers/crmDb');

let PDF;
let db;
let cleanup;
let customerApp;
let adminApp;
let superTok;
let adminId;
let customerA;
let customerB;
let eventA;

const cookieFor = (customerId) => `customer_token=${jwt.sign(
  { type: 'customer', customerId, jti: randomUUID() },
  process.env.JWT_SECRET,
  { issuer: 'picpeak-auth' },
)}`;
const asCustomer = (req, id) => req.set('Cookie', cookieFor(id));
const asAdmin = (req, tok = superTok) => req.set('Authorization', `Bearer ${tok}`);
const idOf = (inserted) => (typeof inserted[0] === 'object' ? inserted[0].id : inserted[0]);
const nowIso = () => new Date().toISOString();

async function setFlag(key, on) {
  await db('feature_flags').where({ key }).update({ value: on ? 1 : 0 });
  require('../../src/middleware/requireFeatureFlag').invalidateFeatureFlagCache();
}

async function insertEvent(slug) {
  return idOf(await db('events').insert({
    slug, event_type: 'wedding', event_name: `Event ${slug}`, event_date: '2026-08-01',
    host_email: 'h@example.com', admin_email: 'a@example.com', password_hash: 'x',
    share_link: `/gallery/${slug}`, share_token: `tok-${slug}`,
    expires_at: new Date(Date.now() + 30 * 864e5).toISOString(),
    is_active: 1, is_archived: 0, is_draft: 0, created_by: adminId, created_at: nowIso(),
  }).returning('id'));
}

function uploadAs(customerId, filename = 'contract.pdf', fields = {}) {
  let req = asCustomer(request(customerApp).post('/api/customer/documents'), customerId);
  for (const [k, v] of Object.entries(fields)) req = req.field(k, String(v));
  return req.attach('file', PDF, { filename, contentType: 'application/pdf' });
}

function adminUpload(customerId, filename = 'offer.pdf', fields = {}) {
  let req = asAdmin(request(adminApp).post(`/api/admin/customers/${customerId}/documents`));
  for (const [k, v] of Object.entries(fields)) req = req.field(k, String(v));
  return req.attach('file', PDF, { filename, contentType: 'application/pdf' });
}

const adminDoc = (customerId, id, suffix = '') => `/api/admin/customers/${customerId}/documents/${id}${suffix}`;
const getDoc = (customerId, id) => asCustomer(request(customerApp).get(`/api/customer/documents/${id}`), customerId);
const download = (customerId, id) => asCustomer(request(customerApp).get(`/api/customer/documents/${id}/download`), customerId);

beforeAll(async () => {
  const doc = await PDFDocument.create();
  doc.addPage([200, 200]);
  PDF = Buffer.from(await doc.save());

  ({ db, cleanup } = await bootCrmDb());
  ({ adminId, customerId: customerA } = await seedMinimal(db));
  await assignAdminRole(db, adminId, 'super_admin');
  superTok = mintAdminToken(adminId);

  customerB = idOf(await db('customer_accounts').insert({
    email: 'other@example.com', display_name: 'Other', password_hash: await bcrypt.hash('x', 4),
    preferred_language: 'en', is_active: 1, created_at: nowIso(),
  }).returning('id'));

  eventA = await insertEvent('ws-event-a');
  await db('event_customer_assignments').insert({ event_id: eventA, customer_account_id: customerA });

  customerApp = buildRouteApp('/api/customer', require('../../src/routes/customer'));
  adminApp = buildRouteApp('/api/admin/customers', require('../../src/routes/adminCustomers'));
  await setFlag('documents', true);
}, 300000);

afterAll(async () => {
  if (cleanup) await cleanup();
});

// ---------------------------------------------------------------------------
// Slice 2 — the document page and its states
// ---------------------------------------------------------------------------

describe('GET /api/customer/documents/:id', () => {
  const NOT_FOUND = { error: 'Document not found', code: 'DOCUMENT_NOT_FOUND' };

  it('returns a shared document with its details', async () => {
    const up = await adminUpload(customerA, 'offer.pdf', { share: 'true', eventId: eventA });
    expect(up.status).toBe(201);
    const res = await getDoc(customerA, up.body.document.id);
    expect(res.status).toBe(200);
    expect(res.body.document).toMatchObject({
      id: up.body.document.id, name: 'offer.pdf', uploadedBy: 'studio', status: 'clean',
      downloadable: true, eventId: eventA, eventSlug: 'ws-event-a',
    });
  });

  it('answers pending and rejected own uploads with their status and no download', async () => {
    const pending = await uploadAs(customerA, 'pending.pdf');
    const res = await getDoc(customerA, pending.body.document.id);
    expect(res.status).toBe(200);
    expect(res.body.document).toMatchObject({ status: 'pending', downloadable: false });

    const rejected = await uploadAs(customerA, 'rejected.pdf');
    await asAdmin(request(adminApp).post(adminDoc(customerA, rejected.body.document.id, '/review')))
      .send({ status: 'rejected', note: 'Unsigned' });
    const res2 = await getDoc(customerA, rejected.body.document.id);
    expect(res2.status).toBe(200);
    expect(res2.body.document).toMatchObject({ status: 'rejected', rejectionReason: 'Unsigned', downloadable: false });
    expect(res2.body.document.reviewedAt).toBeTruthy();
  });

  it('answers 410 DOCUMENT_UNSHARED for a document the studio unshared, on the page and the download', async () => {
    const up = await adminUpload(customerA, 'was-shared.pdf', { share: 'true' });
    const id = up.body.document.id;
    await asAdmin(request(adminApp).post(adminDoc(customerA, id, '/unshare')));

    const page = await getDoc(customerA, id);
    expect(page.status).toBe(410);
    expect(page.body.code).toBe('DOCUMENT_UNSHARED');
    const dl = await download(customerA, id);
    expect(dl.status).toBe(410);
    expect(dl.body.code).toBe('DOCUMENT_UNSHARED');
  });

  it('answers 410 DOCUMENT_REMOVED for a deleted own upload and a deleted shared document', async () => {
    const own = await uploadAs(customerA, 'mine.pdf');
    await asAdmin(request(adminApp).delete(adminDoc(customerA, own.body.document.id)));
    const shared = await adminUpload(customerA, 'shared-then-deleted.pdf', { share: 'true' });
    await asAdmin(request(adminApp).delete(adminDoc(customerA, shared.body.document.id)));

    for (const id of [own.body.document.id, shared.body.document.id]) {
      const page = await getDoc(customerA, id);
      expect(page.status).toBe(410);
      expect(page.body.code).toBe('DOCUMENT_REMOVED');
      const dl = await download(customerA, id);
      expect(dl.status).toBe(410);
      expect(dl.body.code).toBe('DOCUMENT_REMOVED');
    }
  });

  it('answers 404 for a studio upload the customer was never shown', async () => {
    const notShared = await adminUpload(customerA, 'draft.pdf');
    const res = await getDoc(customerA, notShared.body.document.id);
    expect(res.status).toBe(404);
    expect(res.body).toEqual(NOT_FOUND);

    // Not clean yet (a scanner has it pending): also never shown.
    const documentScanService = require('../../src/services/documentScanService');
    documentScanService.registerScanner(async () => 'pending');
    try {
      const pending = await adminUpload(customerA, 'scanning.pdf', { share: 'true' });
      expect(pending.body.document.status).toBe('pending');
      const res2 = await getDoc(customerA, pending.body.document.id);
      expect(res2.status).toBe(404);
      expect(res2.body).toEqual(NOT_FOUND);
    } finally {
      documentScanService.registerScanner(null);
    }
  });

  it('gives another customer the same 404 for every state of A\'s documents — no existence oracle', async () => {
    const unshared = await adminUpload(customerA, 'a-unshared.pdf', { share: 'true' });
    await asAdmin(request(adminApp).post(adminDoc(customerA, unshared.body.document.id, '/unshare')));
    const deleted = await uploadAs(customerA, 'a-deleted.pdf');
    await asAdmin(request(adminApp).delete(adminDoc(customerA, deleted.body.document.id)));
    const visible = await uploadAs(customerA, 'a-visible.pdf');
    const max = await db('customer_documents').max({ m: 'id' }).first();

    const ids = [unshared.body.document.id, deleted.body.document.id, visible.body.document.id, Number(max.m) + 1000];
    for (const id of ids) {
      const page = await getDoc(customerB, id);
      expect({ status: page.status, body: page.body }).toEqual({ status: 404, body: NOT_FOUND });
      const dl = await download(customerB, id);
      expect({ status: dl.status, body: dl.body }).toEqual({ status: 404, body: NOT_FOUND });
    }
  });

  it('answers 404 for ids that are not ids', async () => {
    for (const id of ['abc', '0', '-1', '1.5', '99999999999']) {
      const res = await getDoc(customerA, id);
      expect(res.status).toBe(404);
    }
  });
});
