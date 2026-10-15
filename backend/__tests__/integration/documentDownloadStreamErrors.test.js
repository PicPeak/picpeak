'use strict';

/**
 * Document downloads must survive a file that fails to open (issue 2136).
 *
 * fs.createReadStream opens lazily: the route has already returned when the
 * open fails, so an ENOENT (file removed after the existence check) or any
 * other read error arrives outside handleAsync / try-catch. With a bare
 * `.pipe(res)` that 'error' has no listener and Node ends the process.
 *
 * Per route, through the real router:
 *   - the file is removed between the route's checks and the open → 404,
 *     the file's headers gone, `Cache-Control: no-store`
 *   - any other read error → 500
 * A request that never answers (or an uncaught 'error' failing the suite)
 * is what the unfixed code does.
 */

const path = require('path');
const fs = require('fs');
const { Readable } = require('stream');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const { bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken, createPublicToken, buildRouteApp } = require('./helpers/crmDb');
const formatBoolean = value => require('../../src/utils/dbCompat').formatBoolean(value);

// Installed before any route is required: adminExpenses destructures
// createReadStream at load, the contract routes read fs.createReadStream per
// call. Both go through this spy.
const realCreateReadStream = fs.createReadStream;
let failMode = null; // null | 'vanish' | 'eio'
jest.spyOn(fs, 'createReadStream').mockImplementation(function spy(file, ...rest) {
  if (failMode === 'vanish') {
    // The real race: the file passed every check and is gone at open time.
    fs.rmSync(file, { force: true });
    return realCreateReadStream.call(fs, file, ...rest);
  }
  if (failMode === 'eio') {
    return new Readable({
      read() { this.destroy(Object.assign(new Error('EIO: i/o error, read'), { code: 'EIO' })); },
    });
  }
  return realCreateReadStream.call(fs, file, ...rest);
});

const idOf = r => Number(r[0]?.id ?? r[0]);
let db, cleanup, adminId, customerId, adminToken, customerCookie;
let contractsApp, customerApp, publicApp, expensesApp;
let verification;
let ipCounter = 10;
const nextIp = () => `198.51.100.${ipCounter++}`;

function writeFile(rel, body = '%PDF-1.4\nbytes\n%%EOF\n') {
  const abs = path.join(process.env.STORAGE_PATH, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
  return abs;
}

async function insertContract(over = {}) {
  return idOf(await db('contracts').insert({
    contract_number: `K-2136-${Math.random().toString(16).slice(2, 8)}`,
    customer_account_id: customerId, title: 'Contract', status: 'sent', language: 'de',
    issue_date: new Date().toISOString().slice(0, 10), created_at: new Date().toISOString(),
    ...over,
  }).returning('id'));
}

beforeAll(async () => {
  ({ db, cleanup } = await bootCrmDb());
  ({ adminId, customerId } = await seedMinimal(db));
  await assignAdminRole(db, adminId, 'super_admin');
  require('../../src/middleware/permissions').clearPermissionCache();
  for (const key of ['contracts', 'accounting', 'expenses', 'incomingInvoices']) {
    if (await db('feature_flags').where({ key }).first()) await db('feature_flags').where({ key }).update({ value: formatBoolean(true) });
    else await db('feature_flags').insert({ key, value: formatBoolean(true) });
  }
  await db('customer_accounts').where({ id: customerId }).update({ feature_contracts: true });
  adminToken = mintAdminToken(adminId);
  const session = jwt.sign(
    { type: 'customer', customerId, iat: Math.floor(Date.now() / 1000) - 5 },
    process.env.JWT_SECRET,
    { algorithm: 'HS256', issuer: 'picpeak-auth', expiresIn: '1h' },
  );
  customerCookie = `customer_token=${session}`;
  verification = require('../../src/services/publicDocumentVerificationService');

  contractsApp = buildRouteApp('/api/admin/contracts', require('../../src/routes/adminContracts'));
  customerApp = buildRouteApp('/api/customer', require('../../src/routes/customer'));
  publicApp = buildRouteApp('/api/public/contracts', require('../../src/routes/publicContracts'));
  expensesApp = buildRouteApp('/api/admin/expenses', require('../../src/routes/adminExpenses'));
}, 120000);

afterAll(async () => { if (cleanup) await cleanup(); });
let rasterSpy = null;
afterEach(() => {
  failMode = null;
  if (rasterSpy) { rasterSpy.mockRestore(); rasterSpy = null; }
});

const admin = (app, url) => request(app).get(url).set('Authorization', `Bearer ${adminToken}`);

// Each case builds a fresh row and file, then returns the request to send.
const cases = [
  ['GET /api/admin/contracts/:id/pdf', async () => {
    const rel = `business-docs/contract/2026/${Math.random().toString(16).slice(2)}.pdf`;
    writeFile(rel);
    const id = await insertContract({ pdf_path: path.join(process.env.STORAGE_PATH, rel) });
    return () => admin(contractsApp, `/api/admin/contracts/${id}/pdf`);
  }],
  ['GET /api/admin/contracts/:id/signed-pdf', async () => {
    const rel = `uploads/contracts/signed/${Math.random().toString(16).slice(2)}.pdf`;
    writeFile(rel);
    const id = await insertContract({ signed_pdf_path: path.join(process.env.STORAGE_PATH, rel) });
    return () => admin(contractsApp, `/api/admin/contracts/${id}/signed-pdf`);
  }],
  ['GET /api/customer/contracts/:id/pdf', async () => {
    const rel = `business-docs/contract/2026/${Math.random().toString(16).slice(2)}.pdf`;
    writeFile(rel);
    const id = await insertContract({ pdf_path: path.join(process.env.STORAGE_PATH, rel) });
    return () => request(customerApp).get(`/api/customer/contracts/${id}/pdf`).set('Cookie', customerCookie);
  }],
  ['GET /api/public/contracts/:token/pdf', async () => {
    const rel = `business-docs/contract/2026/${Math.random().toString(16).slice(2)}.pdf`;
    writeFile(rel);
    const id = await insertContract({ pdf_path: path.join(process.env.STORAGE_PATH, rel) });
    const token = await createPublicToken(db, 'contract_action_tokens', { contract_id: id });
    const grant = verification.issueGrant('contract', await db('contract_action_tokens').where({ token }).first(), token);
    return () => request(publicApp).get(`/api/public/contracts/${token}/pdf`)
      .set('X-Document-Access', grant).set('X-Forwarded-For', nextIp());
  }, { 'referrer-policy': 'no-referrer' }],
  ['GET /api/admin/expenses/inbound/:id/file', async () => {
    const rel = `business-docs/inbound/${Math.random().toString(16).slice(2)}.pdf`;
    writeFile(rel);
    const id = idOf(await db('inbound_documents').insert({
      source: 'upload', supplier_name: 'Supplier', total_amount_minor: 5000, currency: 'CHF',
      created_by_admin_id: adminId, file_path: path.join(process.env.STORAGE_PATH, rel), mime_type: 'application/pdf',
    }).returning('id'));
    return () => admin(expensesApp, `/api/admin/expenses/inbound/${id}/file`);
  }, { 'x-content-type-options': 'nosniff', 'content-disposition': 'attachment' }],
  ['GET /api/admin/expenses/inbound/:id/page/:n', async () => {
    const rel = `business-docs/inbound/${Math.random().toString(16).slice(2)}.pdf`;
    writeFile(rel);
    const id = idOf(await db('inbound_documents').insert({
      source: 'upload', supplier_name: 'Supplier', total_amount_minor: 5000, currency: 'CHF',
      created_by_admin_id: adminId, file_path: path.join(process.env.STORAGE_PATH, rel),
      mime_type: 'application/pdf', page_count: 1,
    }).returning('id'));
    // The rasterised page exists when the route resolves it; rendering is not
    // what this suite is about.
    const png = writeFile(`business-docs/inbound-rendered/${id}/page-1.png`, 'png bytes');
    rasterSpy = jest.spyOn(require('../../src/services/rasterizeService'), 'getRenderedPagePath').mockResolvedValue(png);
    return () => admin(expensesApp, `/api/admin/expenses/inbound/${id}/page/1`);
  }, { 'content-type': 'image/png', 'x-content-type-options': 'nosniff', 'content-disposition': 'inline' }],
  ['GET /api/admin/expenses/:id/proof', async () => {
    const rel = `business-docs/receipts/${Math.random().toString(16).slice(2)}.pdf`;
    writeFile(rel);
    const id = idOf(await db('expenses').insert({
      disposition: 'eigener_aufwand', kind: 'amount', description: 'Proof', supplier_name: 'Supplier',
      original_currency: 'CHF', original_amount_minor: 1000, chf_amount_minor: 1000,
      created_by_admin_id: adminId, receipt_path: path.join(process.env.STORAGE_PATH, rel),
    }).returning('id'));
    return () => admin(expensesApp, `/api/admin/expenses/${id}/proof`);
  }, { 'content-type': 'application/pdf', 'x-content-type-options': 'nosniff', 'content-disposition': 'attachment' }],
];

describe.each(cases)('%s', (_name, setup, expectedHeaders = {}) => {
  it('serves the file when it opens', async () => {
    const send = await setup();
    const res = await send().buffer(true).parse((r, cb) => { const c = []; r.on('data', d => c.push(d)); r.on('end', () => cb(null, Buffer.concat(c))); });
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThan(0);
    // The route's own headers still go out with the file.
    expect(res.headers['content-type']).not.toMatch(/application\/json/);
    expect(res.headers['content-disposition']).toMatch(/^(inline|attachment)/);
    for (const [name, value] of Object.entries(expectedHeaders)) expect(res.headers[name]).toBe(value);
  });

  it('answers 404 with the file headers cleared when the file vanishes before it opens', async () => {
    const send = await setup();
    failMode = 'vanish';
    const res = await send();
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'File not found' });
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.headers['content-disposition']).toBeUndefined();
    expect(res.headers['cache-control']).toBe('no-store');
  }, 15000);

  it('answers 500 for any other read error', async () => {
    const send = await setup();
    failMode = 'eio';
    const res = await send();
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to serve file' });
    expect(res.headers['content-disposition']).toBeUndefined();
    expect(res.headers['cache-control']).toBe('no-store');
  }, 15000);
});
