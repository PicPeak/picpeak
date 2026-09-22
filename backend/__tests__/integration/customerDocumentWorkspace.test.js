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
// activity_logs.metadata and email_queue.email_data are JSON text on SQLite
// and json(b) on PostgreSQL.
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

// ---------------------------------------------------------------------------
// Slice 3 — notifications and workflow hooks
// ---------------------------------------------------------------------------

describe('document notifications', () => {
  let me;
  const queued = (type, recipient) => db('email_queue').where({ email_type: type, recipient_email: recipient }).orderBy('id');
  const share = (customerId, id, body = {}) => asAdmin(request(adminApp).post(adminDoc(customerId, id, '/share'))).send(body);
  const setSetting = (key, value) => db('app_settings').where({ setting_key: key })
    .update({ setting_value: JSON.stringify(value) });

  beforeAll(async () => {
    me = await newCustomer({ email: 'notify-me@example.com', preferred_language: 'de', display_name: 'Nora' });
    await db('business_profile').update({ email: 'studio@example.com', company_name: 'Studio Nord' });
  });

  it('queues the share mail in the customer\'s language with a plain link to the document', async () => {
    const up = await adminUpload(me, 'Vertrag.pdf');
    const res = await share(me, up.body.document.id);
    expect(res.status).toBe(200);
    expect(res.body.notification).toBe('queued');

    const rows = await queued('customer_document_shared', 'notify-me@example.com');
    expect(rows).toHaveLength(1);
    const data = meta(rows[0].email_data);
    expect(data).toMatchObject({
      customer_name: 'Nora', business_name: 'Studio Nord', document_title: 'Vertrag.pdf', __language: 'de',
    });
    expect(data.document_link).toMatch(new RegExp(`/customer/documents/${up.body.document.id}$`));
    // No token, no query string, nothing that could sign the customer in.
    const raw = JSON.stringify(data);
    expect(raw).not.toMatch(/token|jwt|eyJ[A-Za-z0-9_-]{10,}/i);
    expect(data.document_link).not.toContain('?');
  });

  it('skips the mail for notify:false, the setting off, an inactive or passive customer, or documents off for them', async () => {
    const answer = (res) => res.body.notification;
    const before = (await queued('customer_document_shared', 'notify-me@example.com')).length;

    const a = await adminUpload(me, 'a.pdf');
    expect(answer(await share(me, a.body.document.id, { notify: false }))).toBe('skipped');

    await setSetting('customer_documents_notify_on_share', false);
    const b = await adminUpload(me, 'b.pdf');
    expect(answer(await share(me, b.body.document.id))).toBe('skipped');
    // An explicit choice wins over the setting.
    const b2 = await adminUpload(me, 'b2.pdf');
    expect(answer(await share(me, b2.body.document.id, { notify: true }))).toBe('queued');
    await setSetting('customer_documents_notify_on_share', true);

    for (const change of [{ is_active: 0 }, { password_hash: null }, { feature_documents: 0 }]) {
      const saved = await db('customer_accounts').where({ id: me }).first('is_active', 'password_hash', 'feature_documents');
      await db('customer_accounts').where({ id: me }).update(change);
      const c = await adminUpload(me, 'c.pdf');
      expect(answer(await share(me, c.body.document.id))).toBe('skipped');
      await db('customer_accounts').where({ id: me }).update(saved);
    }
    expect((await queued('customer_document_shared', 'notify-me@example.com')).length).toBe(before + 1);
  });

  it('keeps the share when the mail cannot be queued, and says so', async () => {
    const emailProcessor = require('../../src/services/emailProcessor');
    const spy = jest.spyOn(emailProcessor, 'queueEmail').mockRejectedValueOnce(new Error('queue down'));
    try {
      const up = await adminUpload(me, 'fails.pdf');
      const res = await share(me, up.body.document.id);
      expect(res.status).toBe(200);
      expect(res.body.notification).toBe('failed');
      const row = await db('customer_documents').where({ id: up.body.document.id }).first();
      expect(row.shared_at).toBeTruthy();
    } finally {
      spy.mockRestore();
    }
  });

  it('announces an upload shared on the way in, honouring notify', async () => {
    const before = (await queued('customer_document_shared', 'notify-me@example.com')).length;
    const quiet = await adminUpload(me, 'quiet.pdf', { share: 'true', notify: 'false' });
    expect(quiet.body.notification).toBe('skipped');
    const loud = await adminUpload(me, 'loud.pdf', { share: 'true' });
    expect(loud.body.notification).toBe('queued');
    expect((await queued('customer_document_shared', 'notify-me@example.com')).length).toBe(before + 1);
  });

  it('tells the business address about a customer upload', async () => {
    const up = await uploadAs(me, 'from-customer.pdf');
    expect(up.status).toBe(201);
    const rows = await queued('customer_document_uploaded_admin', 'studio@example.com');
    const data = rows.map((r) => meta(r.email_data)).find((d) => d.document_title === 'from-customer.pdf');
    expect(data).toMatchObject({ customer_name: 'Nora' });
    expect(data.admin_link).toMatch(new RegExp(`/admin/clients/accounts/${me}$`));
  });

  it('mails a rejection with its note, and nothing for an accepted upload', async () => {
    const rejectedUp = await uploadAs(me, 'wrong.pdf');
    const acceptedUp = await uploadAs(me, 'right.pdf');
    const before = (await queued('customer_document_reviewed', 'notify-me@example.com')).length;
    await asAdmin(request(adminApp).post(adminDoc(me, acceptedUp.body.document.id, '/review'))).send({ status: 'clean' });
    const res = await asAdmin(request(adminApp).post(adminDoc(me, rejectedUp.body.document.id, '/review')))
      .send({ status: 'rejected', note: 'Unterschrift fehlt' });
    expect(res.body.notification).toBe('queued');
    const rows = await queued('customer_document_reviewed', 'notify-me@example.com');
    expect(rows).toHaveLength(before + 1);
    expect(meta(rows[rows.length - 1].email_data)).toMatchObject({
      document_title: 'wrong.pdf', review_note: 'Unterschrift fehlt', __language: 'de',
    });
  });

  it('emits document.shared and document.uploaded for workflows', async () => {
    const workflows = require('../../src/services/workflows');
    const spy = jest.spyOn(workflows, 'emitWorkflowEvent').mockResolvedValue([]);
    try {
      const up = await adminUpload(me, 'wf.pdf');
      await share(me, up.body.document.id);
      const own = await uploadAs(me, 'wf-own.pdf');
      const calls = spy.mock.calls.map(([trigger, opts]) => [trigger, opts.entityId, opts.payload]);
      expect(calls).toEqual(expect.arrayContaining([
        ['document.shared', up.body.document.id, { customerAccountId: me, documentId: up.body.document.id, eventId: null }],
        ['document.uploaded', own.body.document.id, { customerAccountId: me, documentId: own.body.document.id, eventId: null }],
      ]));
    } finally {
      spy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// Slice 6 — admin timeline, portal Recent
// ---------------------------------------------------------------------------

describe('customer activity (admin)', () => {
  let me;
  let other;
  const activity = (id, qs = '', tok = superTok) => asAdmin(request(adminApp).get(`/api/admin/customers/${id}/activity${qs}`), tok);

  beforeAll(async () => {
    me = await newCustomer();
    other = await newCustomer();
  });

  it('lists this customer\'s document activity newest first, with ids and no personal fields', async () => {
    const up = await adminUpload(me, 'timeline.pdf', { share: 'true' });
    await asAdmin(request(adminApp).post(adminDoc(me, up.body.document.id, '/unshare')));
    await adminUpload(other, 'not-mine.pdf');
    // A login carries the address and the IP in its metadata.
    await require('../../src/database/db').logActivity('customer_login',
      { customerId: me, email: 'x@example.com', ipAddress: '203.0.113.9' }, null, { type: 'customer', id: me, name: 'x@example.com' });

    const res = await activity(me);
    expect(res.status).toBe(200);
    const types = res.body.entries.map((e) => e.type);
    expect(types.slice(0, 4)).toEqual([
      'customer_login', 'customer_document_unshared', 'customer_document_shared', 'customer_document_uploaded',
    ]);
    for (const e of res.body.entries) {
      expect(e.metadata.documentId === undefined || typeof e.metadata.documentId === 'number').toBe(true);
    }
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain('203.0.113.9');
    expect(raw).not.toContain('x@example.com');
    expect(raw).not.toContain('timeline.pdf');
    // Other customers' rows never appear.
    const otherDoc = await db('customer_documents').where({ customer_account_id: other }).first('id');
    expect(res.body.entries.some((e) => e.metadata.documentId === otherDoc.id)).toBe(false);
  });

  it('pages by id', async () => {
    const first = await activity(me, '?limit=1');
    expect(first.body.entries).toHaveLength(1);
    expect(first.body.nextBeforeId).toBe(first.body.entries[0].id);
    const second = await activity(me, `?limit=1&beforeId=${first.body.nextBeforeId}`);
    expect(second.body.entries[0].id).toBeLessThan(first.body.entries[0].id);
  });

  it('needs customers.view and answers 404 for an unknown customer', async () => {
    const role = await db('roles').whereNotIn('name', ['super_admin', 'admin']).first();
    const perm = await db('permissions').where({ name: 'customers.view' }).first('id');
    const granted = await db('role_permissions').where({ role_id: role.id, permission_id: perm.id }).first();
    const limitedId = idOf(await db('admin_users').insert({
      username: `noview-${Date.now()}`, email: `noview-${Date.now()}@example.com`, password_hash: 'x',
      must_change_password: false, created_at: nowIso(), role_id: role.id,
    }).returning('id'));
    const tok = mintAdminToken(limitedId);
    if (granted) await db('role_permissions').where({ role_id: role.id, permission_id: perm.id }).del();
    try {
      require('../../src/middleware/permissions').clearPermissionCache();
      expect((await activity(me, '', tok)).status).toBe(403);
    } finally {
      if (granted) await db('role_permissions').insert({ role_id: role.id, permission_id: perm.id });
      require('../../src/middleware/permissions').clearPermissionCache();
    }
    expect((await activity(99999999)).status).toBe(404);
  });
});

describe('portal dashboard: Recent and Needs action', () => {
  let me;
  let other;
  const dashboard = (id) => asCustomer(request(customerApp).get('/api/customer/dashboard'), id);

  beforeAll(async () => {
    me = await newCustomer();
    other = await newCustomer();
  });

  it('shows shared, uploaded and reviewed documents, newest first', async () => {
    const shared = await adminUpload(me, 'recent-shared.pdf', { share: 'true' });
    const own = await uploadAs(me, 'recent-own.pdf');
    await asAdmin(request(adminApp).post(adminDoc(me, own.body.document.id, '/review')))
      .send({ status: 'rejected', note: 'Blurry' });
    const res = await dashboard(me);
    expect(res.status).toBe(200);
    const kinds = res.body.recent.map((r) => `${r.kind}:${r.id}`);
    expect(kinds).toEqual(expect.arrayContaining([
      `document_shared:${shared.body.document.id}`,
      `document_uploaded:${own.body.document.id}`,
      `document_rejected:${own.body.document.id}`,
    ]));
    expect(res.body.recent.find((r) => r.kind === 'document_shared').link)
      .toBe(`/customer/documents/${shared.body.document.id}`);
    const times = res.body.recent.map((r) => r.at);
    expect([...times].sort().reverse()).toEqual(times);

    // The rejected upload is something the customer can act on.
    expect(res.body.needsAction.documents).toEqual([
      { id: own.body.document.id, name: 'recent-own.pdf', reviewNote: 'Blurry' },
    ]);
  });

  it('drops an unshared document from Recent at once, and never shows another customer\'s items', async () => {
    const up = await adminUpload(me, 'soon-gone.pdf', { share: 'true' });
    const theirs = await adminUpload(other, 'theirs.pdf', { share: 'true' });
    expect((await dashboard(me)).body.recent.some((r) => r.id === up.body.document.id)).toBe(true);
    await asAdmin(request(adminApp).post(adminDoc(me, up.body.document.id, '/unshare')));
    const after = await dashboard(me);
    expect(after.body.recent.some((r) => r.kind.startsWith('document_') && r.id === up.body.document.id)).toBe(false);
    expect(after.body.recent.some((r) => r.kind.startsWith('document_') && r.id === theirs.body.document.id)).toBe(false);
  });

  it('leaves document items out when documents are off for the customer', async () => {
    await db('customer_accounts').where({ id: me }).update({ feature_documents: 0 });
    try {
      const res = await dashboard(me);
      expect(res.body.recent.filter((r) => r.kind.startsWith('document_'))).toEqual([]);
      expect(res.body.needsAction.documents).toEqual([]);
    } finally {
      await db('customer_accounts').where({ id: me }).update({ feature_documents: 1 });
    }
  });
});

// ---------------------------------------------------------------------------
// Slice 9 — abuse signals
// ---------------------------------------------------------------------------

describe('document abuse signals', () => {
  let owner;
  let prober;
  let foreignId;
  // Foreign-access recording runs after the 404 went out; wait for it.
  const settle = () => require('../../src/services/customerDocumentAbuse').settled();
  const counter = async (customerId, signal) => {
    await settle();
    return db('customer_document_abuse_counters').where({ customer_account_id: customerId, signal }).first();
  };
  const logged = async (type, customerId) => (await settle(), await db('activity_logs').where({ activity_type: type }))
    .map((r) => meta(r.metadata)).filter((m) => m.customerId === customerId);

  beforeAll(async () => {
    owner = await newCustomer();
    prober = await newCustomer();
    foreignId = (await adminUpload(owner, 'owners.pdf', { share: 'true' })).body.document.id;
  });

  it('counts attempts on another customer\'s existing document, logging once per hour with ids only', async () => {
    expect((await getDoc(prober, foreignId)).status).toBe(404);
    expect((await download(prober, foreignId)).status).toBe(404);
    expect((await asCustomer(request(customerApp).delete(`/api/customer/documents/${foreignId}`), prober)).status).toBe(404);

    expect(Number((await counter(prober, 'forbidden_access')).count)).toBe(3);
    const entries = await logged('customer_document_forbidden_access', prober);
    expect(entries).toEqual([{ customerId: prober }]);
  });

  it('answers the 404 without waiting for the recording, so latency tells nothing', async () => {
    const abuse = require('../../src/services/customerDocumentAbuse');
    const who = await newCustomer();
    // A recording that doesn't finish until the end of the test: the answer
    // must not wait for it.
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const spy = jest.spyOn(abuse, 'recordIfForeign').mockImplementation(() => gate);
    try {
      for (const call of [
        () => getDoc(who, foreignId),
        () => download(who, foreignId),
        () => asCustomer(request(customerApp).delete(`/api/customer/documents/${foreignId}`), who),
      ]) {
        const res = await Promise.race([
          call(),
          new Promise((resolve) => setTimeout(() => resolve({ status: 'timed out' }), 2000)),
        ]);
        expect(res.status).toBe(404);
      }
      expect(spy).toHaveBeenCalledTimes(3);
    } finally {
      release();
      spy.mockRestore();
      await abuse.settled();
    }
  });

  it('does not count ids that do not exist, nor the customer\'s own hidden rows', async () => {
    const quiet = await newCustomer();
    const hidden = (await adminUpload(quiet, 'never-shared.pdf')).body.document.id;
    expect((await getDoc(quiet, 99999999)).status).toBe(404);
    expect((await getDoc(quiet, hidden)).status).toBe(404);
    expect(await counter(quiet, 'forbidden_access')).toBeUndefined();
  });

  it('alerts the business address once when a customer passes the threshold', async () => {
    const loud = await newCustomer();
    await db('business_profile').update({ email: 'studio@example.com' });
    await db('app_settings').where({ setting_key: 'customer_documents_forbidden_alert_threshold' })
      .update({ setting_value: JSON.stringify(3) });
    try {
      const mails = () => db('email_queue').where({ email_type: 'customer_document_access_alert_admin' });
      const before = (await mails()).length;
      for (let i = 0; i < 5; i += 1) {
        await getDoc(loud, foreignId);
        await settle();
      }
      const after = await mails();
      expect(after.length).toBe(before + 1);
      expect(meta(after[after.length - 1].email_data)).toMatchObject({ attempt_count: '3' });
      expect(await logged('customer_document_forbidden_access_alert', loud)).toEqual([{ customerId: loud, count: 3 }]);
    } finally {
      await db('app_settings').where({ setting_key: 'customer_documents_forbidden_alert_threshold' })
        .update({ setting_value: JSON.stringify(20) });
    }
  });

  it('counts quota refusals and rate-limit hits', async () => {
    const full = await newCustomer();
    await db('app_settings').where({ setting_key: 'customer_documents_quota_mb' })
      .update({ setting_value: JSON.stringify(0.00001) });
    try {
      expect((await uploadAs(full, 'too-big.pdf')).status).toBe(413);
    } finally {
      await db('app_settings').where({ setting_key: 'customer_documents_quota_mb' })
        .update({ setting_value: JSON.stringify(250) });
    }
    expect(Number((await counter(full, 'quota_exceeded')).count)).toBe(1);

    const hasty = await newCustomer();
    let last;
    for (let i = 0; i < 21; i += 1) {
      last = await asCustomer(request(customerApp).delete('/api/customer/documents/99999999'), hasty);
    }
    expect(last.status).toBe(429);
    expect(last.body.code).toBe('UPLOAD_RATE_LIMITED');
    expect(Number((await counter(hasty, 'rate_limited')).count)).toBe(1);
    // The deletes of an id that doesn't exist were never forbidden access.
    expect(await counter(hasty, 'forbidden_access')).toBeUndefined();

    const counts = await require('../../src/services/customerDocumentAbuse').last24hCounts();
    expect(counts.forbiddenAccess).toBeGreaterThanOrEqual(8);
    expect(counts.quotaExceeded).toBeGreaterThanOrEqual(1);
    expect(counts.rateLimited).toBeGreaterThanOrEqual(1);
    expect(counts.customersOverThreshold).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Slice 8 — clamd scanner and the hourly re-scan
// ---------------------------------------------------------------------------

describe('malware scanner (fake clamd)', () => {
  const { fakeClamd } = require('./helpers/fakeClamd');
  // Required lazily: loading a service at collect time would open the
  // database before bootCrmDb has pointed it at this suite's file.
  let documentScanService;
  let runCustomerDocumentRescan;
  let fake;
  let me;
  let INFECTED;

  const useClamd = () => {
    process.env.CLAMAV_HOST = '127.0.0.1';
    process.env.CLAMAV_PORT = String(fake.port);
    process.env.CLAMAV_TIMEOUT_MS = '3000';
    documentScanService.registerScanner(require('../../src/services/scanners/clamd').scan);
  };

  beforeAll(async () => {
    documentScanService = require('../../src/services/documentScanService');
    ({ runCustomerDocumentRescan } = require('../../src/services/customerDocumentRescanService'));
    const { PDFName, PDFString } = require('pdf-lib');
    const doc = await PDFDocument.create();
    doc.addPage([200, 200]);
    doc.catalog.set(PDFName.of('Note'), PDFString.of('EICAR-STANDARD-ANTIVIRUS-TEST-FILE'));
    // No object streams: the marker has to sit in the bytes uncompressed.
    INFECTED = Buffer.from(await doc.save({ useObjectStreams: false }));
    fake = await fakeClamd();
    me = await newCustomer();
  });

  afterAll(async () => {
    documentScanService.registerScanner(null);
    delete process.env.CLAMAV_HOST;
    delete process.env.CLAMAV_PORT;
    delete process.env.CLAMAV_TIMEOUT_MS;
    await fake.close();
  });

  afterEach(() => documentScanService.registerScanner(null));

  it('clears a clean upload and refuses an infected one, logging the rejection', async () => {
    useClamd();
    const clean = await uploadAs(me, 'scanned.pdf');
    expect(clean.status).toBe(201);
    expect(clean.body.document).toMatchObject({ status: 'clean', downloadable: true });

    const infected = await asCustomer(request(customerApp).post('/api/customer/documents'), me)
      .attach('file', INFECTED, { filename: 'invoice.pdf', contentType: 'application/pdf' });
    expect(infected.status).toBe(422);
    expect(infected.body.code).toBe('DOCUMENT_REJECTED_BY_SCAN');
    const logged = (await db('activity_logs').where({ activity_type: 'customer_document_scan_rejected' }))
      .map((r) => meta(r.metadata)).filter((m) => m.customerId === me);
    expect(logged).toHaveLength(1);
    expect(await db('customer_documents').where({ customer_account_id: me, original_name: 'invoice.pdf' }).first())
      .toBeUndefined();
  });

  it('re-scans rows left pending and promotes each exactly once under two concurrent runs', async () => {
    // Uploaded while no scanner was registered: pending.
    const a = (await uploadAs(me, 'later-clean.pdf')).body.document.id;
    const b = (await uploadAs(me, 'later-clean-2.pdf')).body.document.id;
    // Swap the stored bytes of a third row for the infected file.
    const c = (await uploadAs(me, 'later-infected.pdf')).body.document.id;
    const stored = await db('customer_documents').where({ id: c }).first('storage_key');
    require('fs').writeFileSync(require('path').join(process.env.STORAGE_PATH, stored.storage_key), INFECTED);

    useClamd();
    const [r1, r2] = await Promise.all([runCustomerDocumentRescan(), runCustomerDocumentRescan()]);
    expect(r1.clean + r2.clean).toBeGreaterThanOrEqual(2);

    const rows = await db('customer_documents').whereIn('id', [a, b, c]).orderBy('id');
    expect(rows.map((r) => r.status)).toEqual(['clean', 'clean', 'rejected']);
    expect(rows.every((r) => r.scanned_at && !r.scan_claimed_until)).toBe(true);
    const cleared = (await db('activity_logs').where({ activity_type: 'customer_document_scan_cleared' }))
      .map((r) => meta(r.metadata)).filter((m) => [a, b].includes(m.documentId));
    expect(cleared).toHaveLength(2);
    const rejected = (await db('activity_logs').where({ activity_type: 'customer_document_scan_rejected' }))
      .map((r) => meta(r.metadata)).filter((m) => m.documentId === c);
    expect(rejected).toHaveLength(1);

    // A second run finds nothing left to do.
    expect(await runCustomerDocumentRescan()).toEqual({ clean: 0, rejected: 0, pending: 0 });
  });

  it('lets an admin decision made during the scan win', async () => {
    const id = (await uploadAs(me, 'decided.pdf')).body.document.id;
    const original = require('../../src/services/scanners/clamd').scan;
    // The admin rejects while the scan is in flight.
    documentScanService.registerScanner(async (p) => {
      await asAdmin(request(adminApp).post(adminDoc(me, id, '/review'))).send({ status: 'rejected', note: 'No' });
      return original(p);
    });
    await runCustomerDocumentRescan();
    const row = await db('customer_documents').where({ id }).first();
    expect(row.status).toBe('rejected');
    expect(row.review_note).toBe('No');
    expect(row.scan_claimed_until).toBeFalsy();
  });

  it('backs off from files it cannot decide on, so the rows behind them are reached', async () => {
    const fsx = require('fs');
    const pathx = require('path');
    const who = await newCustomer();
    const now = new Date().toISOString();
    // Park every pending row from earlier tests out of the way.
    await db('customer_documents').where({ status: 'pending' }).update({ scan_claimed_until: Date.now() + 864e5 * 365 });
    const insertRow = async (content) => {
      const key = `business-docs/customer-documents/${who}/${randomUUID()}.pdf`;
      const abs = pathx.join(process.env.STORAGE_PATH, key);
      fsx.mkdirSync(pathx.dirname(abs), { recursive: true });
      fsx.writeFileSync(abs, content);
      return idOf(await db('customer_documents').insert({
        customer_account_id: who, uploader_type: 'customer', uploader_id: who, original_name: 'x.pdf',
        storage_key: key, mime_type: 'application/pdf', size_bytes: content.length, sha256: 'x',
        status: 'pending', created_at: now, updated_at: now,
      }).returning('id'));
    };
    for (let i = 0; i < 101; i += 1) await insertRow('UNSCANNABLE');
    const good = await insertRow('fine');
    const seen = [];
    documentScanService.registerScanner(async (p) => {
      seen.push(p);
      return require('fs').readFileSync(p, 'utf8') === 'fine' ? 'clean' : 'pending';
    });
    const first = await runCustomerDocumentRescan();
    expect(first).toEqual({ clean: 0, rejected: 0, pending: 100 });
    const second = await runCustomerDocumentRescan();
    expect(second.clean).toBe(1);
    expect((await db('customer_documents').where({ id: good }).first()).status).toBe('clean');
    // Each unscannable file was fetched once, not again in the second run.
    expect(seen).toHaveLength(102);
    // Backed off for a day, measured from the claim.
    const parked = await db('customer_documents').where({ customer_account_id: who, status: 'pending' }).first();
    expect(Number(parked.scan_claimed_until)).toBeGreaterThan(Date.now() + 23 * 3600e3);
    await db('customer_documents').where({ customer_account_id: who }).update({ deleted_at: now });
  });

  it('a scanner rejection reopens the request the file answered and tells the customer', async () => {
    const who = await newCustomer({ email: 'rescan-reject@example.com' });
    const req = (await asAdmin(request(adminApp).post(`/api/admin/customers/${who}/document-requests`))
      .send({ title: 'Signed form', notify: false })).body.request;
    const up = await uploadAs(who, 'answer.pdf', { requestId: req.id });
    expect(up.status).toBe(201);
    expect((await db('customer_document_requests').where({ id: req.id }).first()).status).toBe('fulfilled');
    const stored = await db('customer_documents').where({ id: up.body.document.id }).first('storage_key');
    require('fs').writeFileSync(require('path').join(process.env.STORAGE_PATH, stored.storage_key), INFECTED);

    useClamd();
    await runCustomerDocumentRescan();
    expect((await db('customer_documents').where({ id: up.body.document.id }).first()).status).toBe('rejected');
    expect((await db('customer_document_requests').where({ id: req.id }).first()).status).toBe('open');
    const mails = await db('email_queue').where({ email_type: 'customer_document_reviewed', recipient_email: 'rescan-reject@example.com' });
    expect(mails).toHaveLength(1);
  });

  it('does nothing while no scanner is registered', async () => {
    const id = (await uploadAs(me, 'waits.pdf')).body.document.id;
    expect(await runCustomerDocumentRescan()).toEqual({ clean: 0, rejected: 0, pending: 0 });
    expect((await db('customer_documents').where({ id }).first()).status).toBe('pending');
  });
});

// ---------------------------------------------------------------------------
// Slice 10 — document requests and the reminder ladder
// ---------------------------------------------------------------------------

describe('document requests', () => {
  let me;
  let other;
  const createRequest = (customerId, body) => asAdmin(request(adminApp)
    .post(`/api/admin/customers/${customerId}/document-requests`)).send(body);
  const mails = (type, to) => db('email_queue').where({ email_type: type, recipient_email: to }).orderBy('id');

  beforeAll(async () => {
    me = await newCustomer({ email: 'requests-me@example.com', preferred_language: 'en' });
    other = await newCustomer({ email: 'requests-other@example.com' });
  });

  it('creates a request, mails the customer a link to the upload and lists it under Needs action', async () => {
    const res = await createRequest(me, { title: 'Signed contract', note: 'Page 3 too', dueAt: '2026-10-01T00:00:00.000Z' });
    expect(res.status).toBe(201);
    expect(res.body.request).toMatchObject({ title: 'Signed contract', status: 'open', reminderCount: 0 });
    expect(res.body.notification).toBe('queued');
    const mail = (await mails('customer_document_requested', 'requests-me@example.com'))[0];
    expect(meta(mail.email_data).upload_link).toMatch(new RegExp(`/customer/documents\\?request=${res.body.request.id}$`));

    const list = await asCustomer(request(customerApp).get('/api/customer/document-requests'), me);
    expect(list.body.requests.map((r) => r.id)).toEqual([res.body.request.id]);
    const dash = await asCustomer(request(customerApp).get('/api/customer/dashboard'), me);
    expect(dash.body.needsAction.documentRequests).toEqual([expect.objectContaining({
      id: res.body.request.id, title: 'Signed contract', link: `/customer/documents?request=${res.body.request.id}`,
    })]);
  });

  it('is fulfilled by an upload that names it, in the same write', async () => {
    const req = (await createRequest(me, { title: 'ID copy' })).body.request;
    const up = await uploadAs(me, 'id.pdf', { requestId: req.id });
    expect(up.status).toBe(201);
    const row = await db('customer_document_requests').where({ id: req.id }).first();
    expect(row.status).toBe('fulfilled');
    expect(Number(row.fulfilled_document_id)).toBe(up.body.document.id);
    const list = await asCustomer(request(customerApp).get('/api/customer/document-requests'), me);
    expect(list.body.requests.some((r) => r.id === req.id)).toBe(false);

    // Rejecting the upload opens the request again: the customer still owes it.
    await asAdmin(request(adminApp).post(adminDoc(me, up.body.document.id, '/review'))).send({ status: 'rejected' });
    expect((await db('customer_document_requests').where({ id: req.id }).first()).status).toBe('open');
  });

  it('refuses another customer\'s request, a cancelled one and a bogus id with 404, and stores nothing', async () => {
    const theirs = (await createRequest(other, { title: 'Theirs' })).body.request;
    const cancelled = (await createRequest(me, { title: 'Never mind' })).body.request;
    const cancel = await asAdmin(request(adminApp).delete(`/api/admin/customers/${me}/document-requests/${cancelled.id}`));
    expect(cancel.status).toBe(200);
    const before = Number((await db('customer_documents').count({ c: '*' }).first()).c);
    for (const requestId of [theirs.id, cancelled.id, 'abc', 99999999]) {
      const res = await uploadAs(me, 'x.pdf', { requestId });
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('DOCUMENT_REQUEST_NOT_FOUND');
    }
    expect(Number((await db('customer_documents').count({ c: '*' }).first()).c)).toBe(before);
    expect((await db('customer_document_requests').where({ id: theirs.id }).first()).status).toBe('open');
    // The admin side scopes the same way.
    const wrong = await asAdmin(request(adminApp).delete(`/api/admin/customers/${me}/document-requests/${theirs.id}`));
    expect(wrong.status).toBe(404);
  });

  it('reminds on each step of the ladder once, and never after fulfil or cancel', async () => {
    const { runDocumentRequestReminders } = require('../../src/services/customerDocumentRequestReminderService');
    await db('customer_document_requests').where({ customer_account_id: me, status: 'open' })
      .update({ status: 'cancelled' });
    const open = (await createRequest(me, { title: 'Ladder' })).body.request;
    const done = (await createRequest(me, { title: 'Done already' })).body.request;
    await uploadAs(me, 'done.pdf', { requestId: done.id });
    const gone = (await createRequest(me, { title: 'Cancelled' })).body.request;
    await asAdmin(request(adminApp).delete(`/api/admin/customers/${me}/document-requests/${gone.id}`));

    const reminders = async () => (await mails('customer_document_request_reminder', 'requests-me@example.com')).length;
    const day = 864e5;
    const created = Date.now();
    expect((await runDocumentRequestReminders(created + 2 * day)).reminded).toBe(0);
    // Day 3: the first step, once — two runs together still send one.
    await Promise.all([runDocumentRequestReminders(created + 3.1 * day), runDocumentRequestReminders(created + 3.1 * day)]);
    expect(await reminders()).toBe(1);
    await runDocumentRequestReminders(created + 4 * day);
    expect(await reminders()).toBe(1);
    // Day 7: the second step.
    await runDocumentRequestReminders(created + 7.5 * day);
    expect(await reminders()).toBe(2);
    // The ladder is used up.
    await runDocumentRequestReminders(created + 30 * day);
    expect(await reminders()).toBe(2);
    expect(Number((await db('customer_document_requests').where({ id: open.id }).first()).reminder_count)).toBe(2);
    for (const id of [done.id, gone.id]) {
      expect(Number((await db('customer_document_requests').where({ id }).first()).reminder_count)).toBe(0);
    }
  });

  it('sends no reminders when the ladder setting is empty', async () => {
    const { runDocumentRequestReminders } = require('../../src/services/customerDocumentRequestReminderService');
    await db('app_settings').where({ setting_key: 'customer_documents_request_reminder_days' })
      .update({ setting_value: JSON.stringify('') });
    try {
      await createRequest(me, { title: 'Quiet' });
      expect(await runDocumentRequestReminders(Date.now() + 100 * 864e5)).toEqual({ reminded: 0 });
    } finally {
      await db('app_settings').where({ setting_key: 'customer_documents_request_reminder_days' })
        .update({ setting_value: JSON.stringify('3,7') });
    }
  });
});
