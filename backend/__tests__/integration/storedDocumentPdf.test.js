/**
 * Sent documents open the stored PDF (#1451 roadmap decision #10).
 *
 * Once a quote or invoice has gone out, its PDF must not be re-rendered from
 * today's data — a later change to a template, the branding or a setting
 * would silently alter what the customer received. Pins:
 *   - a sent quote serves the stored file byte for byte;
 *   - a draft renders live;
 *   - a missing stored file falls back to a live render;
 *   - a stored path outside the document storage is never read.
 */

const fs = require('fs');
const path = require('path');
const request = require('supertest');
const {
  bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken, buildRouteApp,
} = require('./helpers/crmDb');

jest.setTimeout(120000);

let db;
let cleanup;
let tmpDir;
let customerId;
let token;
let quoteApp;

const prevCwd = process.cwd();
const auth = { get Authorization() { return `Bearer ${token}`; } };
const STORED = Buffer.from('%PDF-1.7\n% stored copy that went out\n%%EOF\n');

async function createQuote() {
  const res = await request(quoteApp).post('/api/admin/quotes').set(auth).send({
    customerAccountId: customerId, currency: 'CHF', vatRate: 0,
    lineItems: [{ position: 1, quantity: 1, description: 'Coverage', unitPriceMinor: 100000 }],
  });
  expect(res.status).toBe(201);
  return res.body.quote.id;
}

function storedFile(name) {
  const { getStoragePath } = require('../../src/config/storage');
  const dir = path.join(getStoragePath(), 'business-docs', 'quote', 'test');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, STORED);
  return file;
}

const pdfOf = (id) => request(quoteApp).get(`/api/admin/quotes/${id}/pdf`).set(auth)
  .buffer(true).parse((res, cb) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
  });

beforeAll(async () => {
  ({ db, cleanup, tmpDir } = await bootCrmDb());
  process.chdir(tmpDir);
  db.client.pool.acquireTimeoutMillis = 2000;
  let adminId;
  ({ adminId, customerId } = await seedMinimal(db));
  await assignAdminRole(db, adminId, 'super_admin');
  token = mintAdminToken(adminId);
  const updated = await db('feature_flags').where({ key: 'quotes' }).update({ value: true });
  if (!updated) await db('feature_flags').insert({ key: 'quotes', value: true });
  quoteApp = buildRouteApp('/api/admin/quotes', require('../../src/routes/adminQuotes'));
}, 120000);

afterAll(async () => {
  process.chdir(prevCwd);
  if (cleanup) await cleanup();
});

test('a sent quote serves the stored file byte for byte', async () => {
  const id = await createQuote();
  await db('quotes').where({ id }).update({ status: 'sent', pdf_path: storedFile(`Q-${id}.pdf`) });
  const res = await pdfOf(id);
  expect(res.status).toBe(200);
  expect(Buffer.compare(res.body, STORED)).toBe(0);
});

test('a draft renders live, even with a stored file', async () => {
  const id = await createQuote();
  await db('quotes').where({ id }).update({ pdf_path: storedFile(`Q-${id}.pdf`) });
  const res = await pdfOf(id);
  expect(res.status).toBe(200);
  expect(res.body.slice(0, 5).toString()).toBe('%PDF-');
  expect(Buffer.compare(res.body, STORED)).not.toBe(0);
});

test('a missing stored file falls back to a live render', async () => {
  const id = await createQuote();
  await db('quotes').where({ id }).update({ status: 'sent', pdf_path: path.join(tmpDir, 'gone', 'nothing.pdf') });
  const res = await pdfOf(id);
  expect(res.status).toBe(200);
  expect(res.body.slice(0, 5).toString()).toBe('%PDF-');
});

test('a stored path outside the document storage is never read', async () => {
  const id = await createQuote();
  const outside = path.join(tmpDir, 'outside.pdf');
  fs.writeFileSync(outside, STORED);
  await db('quotes').where({ id }).update({ status: 'sent', pdf_path: outside });
  const res = await pdfOf(id);
  expect(res.status).toBe(200);
  expect(Buffer.compare(res.body, STORED)).not.toBe(0);
});
