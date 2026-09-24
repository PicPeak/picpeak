/**
 * A pre-generated watermark for an external photo is served from local disk
 * by joining photos.watermark_path onto the storage root. The column is
 * written by watermarkService, but it is read from a row that a crafted
 * .picpeak import or a compromised database can poison, and a raw join would
 * hand any file the process can read to a gallery guest. The route must
 * refuse to leave the storage root and fall back to on-the-fly watermarking.
 */
const { bootCrmDb, seedMinimal } = require('../integration/helpers/crmDb');
const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
process.env.JWT_SECRET = 'watermark-containment-secret-at-least-32-characters';
const EXTERNAL_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-wm-ext-'));
process.env.EXTERNAL_MEDIA_ROOT = EXTERNAL_ROOT;

jest.mock('../../src/middleware/secureImageMiddleware', () => ({
  secureImageAccess: (req, _res, next) => {
    req.clientInfo = { fingerprint: 'wm-test', ip: '127.0.0.1', userAgent: 'jest' };
    next();
  },
  getSecurityStatus: (_req, res) => res.json({}),
}));

let db, cleanup, tmpDir, app, adminId;
const eventId = 82001, photoId = 82002, slug = 'wm-containment';
const SECRET = Buffer.from('this file lives outside the storage root and must never be served');
const token = () => jwt.sign({ type: 'gallery', eventId, eventSlug: slug,
  iat: Math.floor(Date.now() / 1000) - 60, jti: crypto.randomUUID() },
process.env.JWT_SECRET, { issuer: 'picpeak-auth', expiresIn: '1h' });
const binary = (res, cb) => {
  const chunks = [];
  res.on('data', (c) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};

beforeAll(async () => {
  ({ db, cleanup, tmpDir } = await bootCrmDb());
  ({ adminId } = await seedMinimal(db));
  await db('events').insert({ id: eventId, slug, event_type: 'wedding', event_name: 'Watermark containment',
    event_date: '2026-01-01', host_email: 'h@example.test', admin_email: 'a@example.test', password_hash: 'unused',
    share_link: `/gallery/${slug}`, created_by: adminId, is_active: 1, is_archived: 0, is_draft: 0, require_password: 1,
    expires_at: new Date(Date.now() + 86400000).toISOString() });
  // The photo itself is an external reference, which is the branch that
  // reads the watermark from local disk.
  const external = path.join(EXTERNAL_ROOT, slug, 'ext.jpg');
  fs.mkdirSync(path.dirname(external), { recursive: true });
  await require('sharp')({ create: { width: 8, height: 8, channels: 3, background: '#882244' } }).jpeg().toFile(external);
  // Storage is <tmpDir>/storage (bootCrmDb); the secret sits next to it.
  const outside = path.join(tmpDir, 'outside', 'secret.bin');
  fs.mkdirSync(path.dirname(outside), { recursive: true });
  fs.writeFileSync(outside, SECRET);
  await db('photos').insert({ id: photoId, event_id: eventId, filename: 'ext.jpg', path: `${slug}/ext.jpg`,
    source_origin: 'external', external_relpath: `${slug}/ext.jpg`, type: 'individual', mime_type: 'image/jpeg',
    processing_status: 'complete', size_bytes: fs.statSync(external).size,
    watermark_path: '../outside/secret.bin' });
  await db('app_settings').insert({ setting_key: 'branding_watermark_enabled', setting_value: 'true', setting_type: 'boolean' })
    .onConflict('setting_key').merge();
  const secure = require('../../src/services/secureImageService');
  jest.spyOn(secure, 'createClientFingerprint').mockReturnValue('wm-test');
  app = express(); app.use(express.json()); app.use(cookieParser());
  app.use('/api/gallery', require('../../src/routes/gallery'));
}, 120000);

afterAll(async () => {
  fs.rmSync(EXTERNAL_ROOT, { recursive: true, force: true });
  await cleanup();
});

it('never serves a watermark_path that climbs out of the storage root', async () => {
  const res = await request(app).get(`/api/gallery/${slug}/photo/${photoId}`)
    .set('Authorization', `Bearer ${token()}`).buffer(true).parse(binary);
  expect(res.body.includes(SECRET)).toBe(false);
  expect(res.body.equals(SECRET)).toBe(false);
});
