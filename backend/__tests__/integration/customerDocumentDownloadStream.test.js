'use strict';

/**
 * Customer document downloads, portal and admin (issue 2137).
 *
 * Both routes open the document stream and then await their bookkeeping
 * (recordView, logActivity) before piping it. The local read stream opens
 * lazily, so a missing file fired ENOENT during those awaits with no listener
 * and ended the process; a rejecting bookkeeping call answered an error and
 * left the opened stream (an S3 socket) behind.
 *
 * Per route, through the real router:
 *   - the file is served and one view recorded
 *   - the file vanishes before it opens → 404, the suite survives, no view
 *     recorded
 *   - recordView / logActivity rejects → an error answered, stream destroyed
 */

const path = require('path');
const fs = require('fs');
const { randomUUID } = require('crypto');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const { bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken, buildRouteApp } = require('./helpers/crmDb');
const formatBoolean = value => require('../../src/utils/dbCompat').formatBoolean(value);

// Every stream the routes open, so a test can check it was released.
const realCreateReadStream = fs.createReadStream;
const opened = [];
let vanish = false;
jest.spyOn(fs, 'createReadStream').mockImplementation(function spy(file, ...rest) {
  // The race: the file passed the path check and is gone at open time. A
  // file already missing is refused by that check (FILE_MISSING) instead.
  if (vanish) fs.rmSync(file, { force: true });
  const stream = realCreateReadStream.call(fs, file, ...rest);
  opened.push(stream);
  return stream;
});

const idOf = r => Number(r[0]?.id ?? r[0]);
let db, cleanup, customerId, adminToken, customerCookie;
let customerApp, adminApp, documentsService, logActivitySpy;

beforeAll(async () => {
  ({ db, cleanup } = await bootCrmDb());
  let adminId;
  ({ adminId, customerId } = await seedMinimal(db));
  await assignAdminRole(db, adminId, 'super_admin');
  require('../../src/middleware/permissions').clearPermissionCache();
  if (await db('feature_flags').where({ key: 'documents' }).first()) {
    await db('feature_flags').where({ key: 'documents' }).update({ value: formatBoolean(true) });
  } else {
    await db('feature_flags').insert({ key: 'documents', value: formatBoolean(true) });
  }
  require('../../src/middleware/requireFeatureFlag').invalidateFeatureFlagCache();
  adminToken = mintAdminToken(adminId);
  const session = jwt.sign(
    { type: 'customer', customerId, iat: Math.floor(Date.now() / 1000) - 5 },
    process.env.JWT_SECRET,
    { algorithm: 'HS256', issuer: 'picpeak-auth', expiresIn: '1h' },
  );
  customerCookie = `customer_token=${session}`;

  // Before the routes load: both destructure logActivity at require time.
  logActivitySpy = jest.spyOn(require('../../src/database/db'), 'logActivity');
  documentsService = require('../../src/services/customerDocumentsService');
  customerApp = buildRouteApp('/api/customer', require('../../src/routes/customer'));
  adminApp = buildRouteApp('/api/admin/customers', require('../../src/routes/adminCustomers'));
}, 120000);

afterAll(async () => { if (cleanup) await cleanup(); });
afterEach(() => { opened.length = 0; vanish = false; });

async function insertDocument() {
  const key = `business-docs/customer-documents/${customerId}/${randomUUID()}.pdf`;
  const abs = path.join(process.env.STORAGE_PATH, key);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, '%PDF-1.4\nbytes\n%%EOF\n');
  const now = new Date().toISOString();
  const id = idOf(await db('customer_documents').insert({
    customer_account_id: customerId, uploader_type: 'customer', uploader_id: customerId,
    original_name: 'contract.pdf', storage_key: key, mime_type: 'application/pdf',
    size_bytes: 22, sha256: 'x'.repeat(64), status: 'clean', reviewed_at: now,
    created_at: now, updated_at: now,
  }).returning('id'));
  return { id };
}

const views = async id => Number((await db('customer_document_views').where({ document_id: id }).count('* as c').first()).c);
const binary = (r, cb) => { const c = []; r.on('data', d => c.push(d)); r.on('end', () => cb(null, Buffer.concat(c))); };

const routes = [
  ['GET /api/customer/documents/:id/download',
    id => request(customerApp).get(`/api/customer/documents/${id}/download`).set('Cookie', customerCookie)],
  ['GET /api/admin/customers/:id/documents/:docId/download',
    id => request(adminApp).get(`/api/admin/customers/${customerId}/documents/${id}/download`)
      .set('Authorization', `Bearer ${adminToken}`)],
];

describe.each(routes)('%s', (_name, send) => {
  it('serves the file and records one view', async () => {
    const { id } = await insertDocument();
    const res = await send(id).buffer(true).parse(binary);
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toMatch(/^attachment;/);
    expect(res.body.toString()).toContain('%PDF-1.4');
    expect(await views(id)).toBe(1);
  });

  it('answers 404 for a file that vanishes before it opens, without crashing, and records no view', async () => {
    const { id } = await insertDocument();
    vanish = true;
    const res = await send(id);
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.headers['content-disposition']).toBeUndefined();
    expect(await views(id)).toBe(0);
  }, 15000);

  it('destroys the opened stream when recordView rejects', async () => {
    const { id } = await insertDocument();
    const spy = jest.spyOn(documentsService, 'recordView').mockRejectedValueOnce(new Error('db down'));
    try {
      const res = await send(id);
      expect(res.status).toBe(500);
      expect(opened).toHaveLength(1);
      expect(opened[0].destroyed).toBe(true);
    } finally {
      spy.mockRestore();
    }
  }, 15000);

  it('destroys the opened stream when logActivity rejects', async () => {
    const { id } = await insertDocument();
    logActivitySpy.mockRejectedValueOnce(new Error('db down'));
    const res = await send(id);
    expect(res.status).toBe(500);
    expect(opened).toHaveLength(1);
    expect(opened[0].destroyed).toBe(true);
  }, 15000);
});
