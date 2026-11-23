/**
 * Earlier versions of a quote stay readable in PicPeak.
 *
 * Editing a sent quote overwrites its lines in place, so the PDFs it went out
 * as are the only record of what each earlier send offered. Real admin
 * routes → quoteService → SQLite with the full core-migration run
 * (helpers/crmDb). Pins:
 *   - every send keeps its own file, listed newest first, with the totals
 *     and lines it was stored with;
 *   - each version opens as the bytes stored at the time, not a re-render;
 *   - a version of another quote, or one whose file is gone, is a 404.
 */

const fs = require('fs');
const request = require('supertest');
const {
  bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken, buildRouteApp,
} = require('./helpers/crmDb');

jest.setTimeout(120000);

let db;
let cleanup;
let tmpDir;
let adminId;
let customerId;
let token;
let adminApp;
let quoteService;

const prevCwd = process.cwd();
const auth = { get Authorization() { return `Bearer ${token}`; } };

async function setFlag(key, value) {
  const updated = await db('feature_flags').where({ key }).update({ value });
  if (!updated) await db('feature_flags').insert({ key, value });
  require('../../src/middleware/requireFeatureFlag').invalidateFeatureFlagCache();
}

beforeAll(async () => {
  ({ db, cleanup, tmpDir } = await bootCrmDb());
  process.chdir(tmpDir);
  db.client.pool.acquireTimeoutMillis = 2000;
  ({ adminId, customerId } = await seedMinimal(db));
  await assignAdminRole(db, adminId, 'super_admin');
  token = mintAdminToken(adminId);
  await setFlag('quotes', true);
  quoteService = require('../../src/services/quoteService');
  adminApp = buildRouteApp('/api/admin/quotes', require('../../src/routes/adminQuotes'));
}, 120000);

afterAll(async () => {
  process.chdir(prevCwd);
  if (cleanup) await cleanup();
});

const lines = (images, priceMinor) => [
  { position: 1, quantity: images, unit: 'piece', description: 'Edited images\nhigh resolution', unit_price_minor: priceMinor },
];

const pdfOf = (res) => {
  // supertest buffers application/pdf as a Buffer when asked to.
  expect(res.headers['content-type']).toMatch(/application\/pdf/);
  return res.body;
};

const binary = (req) => req.buffer(true).parse((res, cb) => {
  const chunks = [];
  res.on('data', (c) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
});

test('each send is kept and listed with what it offered', async () => {
  // CHF 400 for 80 images, sent; then CHF 300 for 40 images, sent again.
  const quoteId = await quoteService.createQuote({
    customerAccountId: customerId, currency: 'CHF', vatRate: 0, lineItems: lines(80, 500),
  }, adminId);
  await quoteService.sendQuote(quoteId, adminId);
  await quoteService.updateQuote(quoteId, { lineItems: lines(40, 750) }, adminId);
  expect((await db('quotes').where({ id: quoteId }).first()).status).toBe('draft');
  await quoteService.sendQuote(quoteId, adminId);

  const res = await request(adminApp).get(`/api/admin/quotes/${quoteId}/documents`).set(auth);
  expect(res.status).toBe(200);
  const { documents } = res.body;
  expect(documents).toHaveLength(2);
  expect(documents.map((d) => d.kind)).toEqual(['sent', 'sent']);
  // Newest first; no file paths leave the API.
  const [latest, first] = documents;
  expect(latest.summary).toEqual({
    currency: 'CHF',
    netAmountMinor: 30000,
    totalAmountMinor: 30000,
    lines: [{
      description: 'Edited images', quantity: 40, unit: 'piece', lineTotalMinor: 30000, lineKind: 'item', notIncluded: false,
    }],
  });
  expect(first.summary.totalAmountMinor).toBe(40000);
  expect(first.summary.lines[0].quantity).toBe(80);
  expect(JSON.stringify(documents)).not.toMatch(/business-docs/);

  // Each version opens as the file stored at the time.
  const stored = await db('generated_documents').where({ doc_type: 'quote', doc_id: quoteId }).orderBy('id', 'asc');
  for (const row of stored) {
    const file = await binary(request(adminApp).get(`/api/admin/quotes/${quoteId}/documents/${row.id}/pdf`).set(auth));
    expect(file.status).toBe(200);
    const body = pdfOf(file);
    expect(require('crypto').createHash('sha256').update(body).digest('hex')).toBe(row.sha256);
  }
  expect(stored[0].sha256).not.toBe(stored[1].sha256);
});

test('a version of another quote, or one whose file is gone, is a 404', async () => {
  const quoteId = await quoteService.createQuote({
    customerAccountId: customerId, currency: 'CHF', vatRate: 0, lineItems: lines(10, 1000),
  }, adminId);
  await quoteService.sendQuote(quoteId, adminId);
  const otherId = await quoteService.createQuote({
    customerAccountId: customerId, currency: 'CHF', vatRate: 0, lineItems: lines(5, 1000),
  }, adminId);
  const row = await db('generated_documents').where({ doc_type: 'quote', doc_id: quoteId }).first();

  const foreign = await request(adminApp).get(`/api/admin/quotes/${otherId}/documents/${row.id}/pdf`).set(auth);
  expect(foreign.status).toBe(404);

  const { resolveStoredPath } = require('../../src/utils/storedPath');
  fs.unlinkSync(resolveStoredPath(row.path) || row.path);
  const gone = await request(adminApp).get(`/api/admin/quotes/${quoteId}/documents/${row.id}/pdf`).set(auth);
  expect(gone.status).toBe(404);
  expect(gone.body.code).toBe('DOCUMENT_FILE_MISSING');

  // A quote never sent has no versions.
  const none = await request(adminApp).get(`/api/admin/quotes/${otherId}/documents`).set(auth);
  expect(none.status).toBe(200);
  expect(none.body.documents).toEqual([]);
});
