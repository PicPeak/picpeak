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
// activity_logs.metadata is JSON text on SQLite and jsonb on PostgreSQL.
const meta = (v) => (typeof v === 'string' ? JSON.parse(v) : v);

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

// The portal's upload limit (20 per 10 minutes, per customer) covers deletes
// too, so each block of tests works as a customer of its own.
let customerSeq = 0;
async function newCustomer(overrides = {}) {
  customerSeq += 1;
  return idOf(await db('customer_accounts').insert({
    email: `ws-${customerSeq}@example.com`, display_name: `Customer ${customerSeq}`, password_hash: 'x',
    preferred_language: 'en', is_active: 1, created_at: nowIso(), ...overrides,
  }).returning('id'));
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

// ---------------------------------------------------------------------------
// Slice 4 — customers delete their own uploads
// ---------------------------------------------------------------------------

describe('DELETE /api/customer/documents/:id', () => {
  const remove = (customerId, id) => asCustomer(request(customerApp).delete(`/api/customer/documents/${id}`), customerId);
  let me;
  const usage = () => require('../../src/services/customerDocumentsService').getUsageBytes(me);
  beforeAll(async () => { me = await newCustomer(); });

  it('deletes the customer\'s own upload in any status, frees the quota and logs it', async () => {
    const pending = await uploadAs(me, 'mine-pending.pdf');
    const clean = await uploadAs(me, 'mine-clean.pdf');
    await asAdmin(request(adminApp).post(adminDoc(me, clean.body.document.id, '/review'))).send({ status: 'clean' });
    const rejected = await uploadAs(me, 'mine-rejected.pdf');
    await asAdmin(request(adminApp).post(adminDoc(me, rejected.body.document.id, '/review'))).send({ status: 'rejected' });

    for (const up of [pending, clean, rejected]) {
      const id = up.body.document.id;
      expect(up.body.document.canDelete).toBe(true);
      const before = await usage();
      const res = await remove(me, id);
      expect(res.status).toBe(200);
      expect(await usage()).toBe(before - PDF.length);
      const row = await db('customer_documents').where({ id }).first();
      expect(row.deleted_at).toBeTruthy();
      expect(row.purged_at).toBeFalsy();
      expect((await getDoc(me, id)).body.code).toBe('DOCUMENT_REMOVED');
    }
    const logged = await db('activity_logs').where({ activity_type: 'customer_document_deleted' })
      .whereRaw('actor_type = ?', ['customer']);
    const mine = logged.map((e) => meta(e.metadata)).filter((m) => m.customerId === me);
    expect(mine).toHaveLength(3);
    for (const m of mine) expect(m).toEqual({ documentId: expect.any(Number), customerId: me });
  });

  it('answers 404 for a document the studio shared, another customer\'s, an unknown id and a second delete', async () => {
    const shared = await adminUpload(me, 'studio.pdf', { share: 'true' });
    const theirs = await uploadAs(customerB, 'theirs.pdf');
    const mine = await uploadAs(me, 'twice.pdf');
    expect((await remove(me, mine.body.document.id)).status).toBe(200);

    for (const [who, id] of [
      [me, shared.body.document.id],
      [me, theirs.body.document.id],
      [me, 99999999],
      [me, mine.body.document.id],
    ]) {
      const res = await remove(who, id);
      expect({ status: res.status, body: res.body })
        .toEqual({ status: 404, body: { error: 'Document not found', code: 'DOCUMENT_NOT_FOUND' } });
    }
    expect((await db('customer_documents').where({ id: shared.body.document.id }).first()).deleted_at).toBeFalsy();
    expect((await db('customer_documents').where({ id: theirs.body.document.id }).first()).deleted_at).toBeFalsy();
  });

  it('refuses a contract-linked upload with 409 until it is unlinked', async () => {
    const contractId = idOf(await db('contracts').insert({
      contract_number: `K-SELF-${Date.now()}`, customer_account_id: me, title: 'Signed',
      status: 'sent', language: 'de', issue_date: new Date().toISOString().slice(0, 10), created_at: nowIso(),
    }).returning('id'));
    const up = await uploadAs(me, 'signed.pdf', { contractId });
    expect(up.status).toBe(201);
    expect(up.body.document.canDelete).toBe(false);

    const res = await remove(me, up.body.document.id);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('DOCUMENT_CONTRACT_LINKED');
    expect((await db('customer_documents').where({ id: up.body.document.id }).first()).deleted_at).toBeFalsy();

    await db('customer_documents').where({ id: up.body.document.id }).update({ contract_id: null });
    expect((await remove(me, up.body.document.id)).status).toBe(200);
    await db('contracts').where({ id: contractId }).del();
  });

  it('is refused cross-site by the CSRF gate before it reaches the route', async () => {
    const express = require('express');
    const cookieParser = require('cookie-parser');
    const app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api', require('../../src/middleware/csrf'));
    app.use('/api/customer', require('../../src/routes/customer'));

    const up = await uploadAs(me, 'csrf.pdf');
    const id = up.body.document.id;
    const crossSite = await request(app).delete(`/api/customer/documents/${id}`)
      .set('Cookie', cookieFor(me)).set('Origin', 'https://evil.example');
    expect(crossSite.status).toBe(403);
    expect((await db('customer_documents').where({ id }).first()).deleted_at).toBeFalsy();

    const sameSite = await request(app).delete(`/api/customer/documents/${id}`)
      .set('Cookie', cookieFor(me)).set('sec-fetch-site', 'same-origin');
    expect(sameSite.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Slice 5 — project link and the deal lineage on the event page
// ---------------------------------------------------------------------------

describe('event page documents follow the deal', () => {
  let me;
  let event;
  let dealContract;
  let otherDealContract;
  let project;
  const slug = 'ws-lineage';
  const overview = () => asCustomer(request(customerApp).get(`/api/customer/events/${slug}/overview`), me);

  beforeAll(async () => {
    me = await newCustomer();
    project = idOf(await db('projects').insert({ name: 'Lineage', customer_account_id: me, created_at: nowIso() }).returning('id'));
    event = await insertEvent(slug);
    await db('events').where({ id: event }).update({ project_id: project });
    await db('event_customer_assignments').insert({ event_id: event, customer_account_id: me });

    // The deal reaches the event through its invoice; the contract of the
    // same deal names no event itself.
    const deal = randomUUID();
    await db('invoices').insert({
      invoice_number: `I-LIN-${Date.now()}`, customer_account_id: me, status: 'sent',
      issue_date: '2026-08-01', due_date: '2026-08-15', event_id: event, deal_uuid: deal,
    });
    dealContract = idOf(await db('contracts').insert({
      contract_number: `K-LIN-${Date.now()}`, customer_account_id: me, status: 'sent',
      issue_date: '2026-08-01', deal_uuid: deal,
    }).returning('id'));
    otherDealContract = idOf(await db('contracts').insert({
      contract_number: `K-OTHER-${Date.now()}`, customer_account_id: me, status: 'sent',
      issue_date: '2026-08-01', deal_uuid: randomUUID(),
    }).returning('id'));
  });

  it('lists a document linked only to a contract of the event\'s deal', async () => {
    const viaContract = await adminUpload(me, 'deal-contract.pdf', { share: 'true', contractId: dealContract });
    const unrelated = await adminUpload(me, 'other-deal.pdf', { share: 'true', contractId: otherDealContract });
    expect(viaContract.status).toBe(201);
    const res = await overview();
    expect(res.status).toBe(200);
    const ids = res.body.documents.map((d) => d.id);
    expect(ids).toContain(viaContract.body.document.id);
    expect(ids).not.toContain(unrelated.body.document.id);
  });

  it('lists a document linked to the event\'s project', async () => {
    const viaProject = await adminUpload(me, 'project.pdf', { share: 'true', projectId: project });
    expect(viaProject.status).toBe(201);
    const res = await overview();
    expect(res.body.documents.map((d) => d.id)).toContain(viaProject.body.document.id);
  });

  it('still lists only what the customer may see', async () => {
    const unshared = await adminUpload(me, 'not-shared.pdf', { contractId: dealContract });
    const res = await overview();
    expect(res.body.documents.map((d) => d.id)).not.toContain(unshared.body.document.id);
  });

  it('refuses linking a document to another customer\'s contract or project', async () => {
    const foreignContract = idOf(await db('contracts').insert({
      contract_number: `K-FOREIGN-${Date.now()}`, customer_account_id: customerB, status: 'sent', issue_date: '2026-08-01',
    }).returning('id'));
    const foreignProject = idOf(await db('projects').insert({
      name: 'Theirs', customer_account_id: customerB, created_at: nowIso(),
    }).returning('id'));
    const customerLess = idOf(await db('projects').insert({ name: 'Nobody', created_at: nowIso() }).returning('id'));

    expect((await adminUpload(me, 'x.pdf', { contractId: foreignContract })).status).toBe(400);
    expect((await adminUpload(me, 'x.pdf', { projectId: foreignProject })).status).toBe(400);
    expect((await adminUpload(me, 'x.pdf', { projectId: customerLess })).status).toBe(400);

    const own = await adminUpload(me, 'relink.pdf');
    const patch = await asAdmin(request(adminApp).patch(adminDoc(me, own.body.document.id)))
      .send({ eventId: null, projectId: foreignProject, contractId: null });
    expect(patch.status).toBe(400);
    expect((await db('customer_documents').where({ id: own.body.document.id }).first()).project_id).toBeNull();
  });
});
