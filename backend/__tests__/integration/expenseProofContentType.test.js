'use strict';

/**
 * An expense proof image goes out as the image it is (issue 2178).
 *
 * Every non-PDF proof was application/octet-stream, so a browser naming the
 * download from its MIME type saved a JPEG receipt without an image
 * extension. A JPEG/PNG/WebP/GIF is now named from its own leading bytes;
 * the extension proves nothing, and anything else stays opaque. nosniff and
 * the CSP go out unchanged.
 */

const path = require('path');
const fs = require('fs');
const request = require('supertest');
const sharp = require('sharp');
const { bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken, buildRouteApp } = require('./helpers/crmDb');
const formatBoolean = value => require('../../src/utils/dbCompat').formatBoolean(value);

const idOf = r => Number(r[0]?.id ?? r[0]);
const CSP = 'default-src \'none\'; img-src \'self\' data:; style-src \'unsafe-inline\'';
let db, cleanup, adminId, adminToken, app;

async function proof(name, bytes) {
  const rel = `business-docs/expenses/proof/2026/${Math.random().toString(16).slice(2)}-${name}`;
  const abs = path.join(process.env.STORAGE_PATH, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, bytes);
  const id = idOf(await db('expenses').insert({
    disposition: 'eigener_aufwand', kind: 'amount', description: 'Proof', supplier_name: 'Supplier',
    original_currency: 'CHF', original_amount_minor: 1000, chf_amount_minor: 1000,
    created_by_admin_id: adminId, receipt_path: abs,
  }).returning('id'));
  return request(app).get(`/api/admin/expenses/${id}/proof`).set('Authorization', `Bearer ${adminToken}`);
}

beforeAll(async () => {
  ({ db, cleanup } = await bootCrmDb());
  ({ adminId } = await seedMinimal(db));
  await assignAdminRole(db, adminId, 'super_admin');
  require('../../src/middleware/permissions').clearPermissionCache();
  for (const key of ['accounting', 'expenses']) {
    if (await db('feature_flags').where({ key }).first()) await db('feature_flags').where({ key }).update({ value: formatBoolean(true) });
    else await db('feature_flags').insert({ key, value: formatBoolean(true) });
  }
  adminToken = mintAdminToken(adminId);
  app = buildRouteApp('/api/admin/expenses', require('../../src/routes/adminExpenses'));
}, 120000);

afterAll(async () => { if (cleanup) await cleanup(); });

const image = sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 10, g: 20, b: 30 } } });

it.each([
  ['receipt.jpg', () => image.clone().jpeg().toBuffer(), 'image/jpeg'],
  ['receipt.png', () => image.clone().png().toBuffer(), 'image/png'],
  // The extension does not decide: a PNG stored as .jpg is a PNG.
  ['renamed.jpg', () => image.clone().png().toBuffer(), 'image/png'],
])('names %s from its bytes', async (name, bytes, type) => {
  const res = await proof(name, await bytes());
  expect(res.status).toBe(200);
  expect(res.headers['content-type']).toBe(type);
  expect(res.headers['content-disposition']).toBe('inline');
  expect(res.headers['x-content-type-options']).toBe('nosniff');
  expect(res.headers['content-security-policy']).toBe(CSP);
});

it.each([
  ['page.jpg', '<html><script>alert(1)</script></html>'],
  ['vector.jpg', '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'],
  ['unknown.bin', 'not an image at all'],
])('keeps %s opaque', async (name, body) => {
  const res = await proof(name, Buffer.from(body));
  expect(res.status).toBe(200);
  expect(res.headers['content-type']).toBe('application/octet-stream');
  expect(res.headers['x-content-type-options']).toBe('nosniff');
  expect(res.headers['content-security-policy']).toBe(CSP);
});

it('leaves a PDF proof as it was', async () => {
  const res = await proof('receipt.pdf', Buffer.from('%PDF-1.4\nbytes\n%%EOF\n'));
  expect(res.status).toBe(200);
  expect(res.headers['content-type']).toBe('application/pdf');
  expect(res.headers['content-disposition']).toBe('attachment');
  expect(res.headers['content-security-policy']).toBeUndefined();
});
