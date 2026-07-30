/**
 * Secure-image view route token binding (GHSA-g94x-8vv8-3c9f).
 *
 * The view route GET /api/secure-images/:slug/secure/:photoId/:token serves
 * via <img src> with the token in the URL, so it can't carry a gallery-token
 * header like the download sibling. Before the fix it validated only the
 * token signature and took the gallery/photo from the URL — so a token minted
 * on any PUBLIC gallery read every other gallery's photos with no password.
 *
 * Pins that the route now enforces the scope inside the token:
 *  - the URL photoId must equal the token's minted photoId
 *  - the gallery embedded in the token's sessionId must equal the URL gallery
 * A token minted on gallery A cannot read gallery B under either check; a
 * token used on its own gallery+photo passes the binding.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-secimg-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'secimg-test-secret';
process.env.STORAGE_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-secimg-storage-'));

// Stub the anti-bot/rate-limit middleware so the fingerprint is deterministic
// — the token below is minted with the same fingerprint, so verifySecureToken
// passes and the binding logic under test is what decides the outcome.
jest.mock('../../src/middleware/secureImageMiddleware', () => ({
  secureImageAccess: (req, _res, next) => {
    req.clientInfo = { fingerprint: 'test-fp', ip: '127.0.0.1', userAgent: 'jest' };
    next();
  },
  getSecurityStatus: (_req, res) => res.json({ ok: true }),
}));

const request = require('supertest');
const express = require('express');

const { bootCrmDb, seedMinimal } = require('../integration/helpers/crmDb');
const secureImageService = require('../../src/services/secureImageService');

describe('secure-image view route token binding (GHSA-g94x)', () => {
  let db;
  let cleanup;
  let app;
  let galleryA; let galleryB;
  let photoA; let photoB;

  const mkEvent = async (slug, requirePassword) => {
    const r = await db('events').insert({
      slug,
      event_type: 'wedding',
      event_name: slug,
      event_date: '2026-08-01',
      host_email: 'h@example.com',
      admin_email: 'a@example.com',
      password_hash: 'x',
      require_password: requirePassword ? 1 : 0,
      share_link: `/gallery/${slug}/share`,
      share_token: `${slug}-share`,
      expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
      is_active: 1,
      is_archived: 0,
      is_draft: 0,
      created_at: new Date().toISOString(),
    }).returning('id');
    return r[0]?.id ?? r[0];
  };

  const mkPhoto = async (eventId, slug, filename) => {
    const dir = path.join(process.env.STORAGE_PATH, 'events/active', slug);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, filename), Buffer.from('img'));
    const r = await db('photos').insert({
      event_id: eventId,
      filename,
      path: `${slug}/${filename}`,
      type: 'individual',
      uploaded_at: new Date().toISOString(),
    }).returning('id');
    return r[0]?.id ?? r[0];
  };

  // Mint a token exactly as the mint route does — bound to (photoId, gallery
  // sessionId, fingerprint) — bypassing the anti-bot HTTP path.
  const mint = (photoId, eventId) => secureImageService.generateSecureToken(
    photoId,
    `gallery_public_${eventId}_${Date.now()}`,
    { clientFingerprint: 'test-fp', maxUses: 100, expiresIn: 3600 },
  );

  const view = (slug, photoId, token) => request(app)
    .get(`/api/secure-images/${slug}/secure/${photoId}/${token}`);

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    await seedMinimal(db);
    galleryA = await mkEvent('secimg-public-a', false);   // public — token source
    galleryB = await mkEvent('secimg-private-b', true);   // password-protected — victim
    photoA = await mkPhoto(galleryA, 'secimg-public-a', 'a.jpg');
    photoB = await mkPhoto(galleryB, 'secimg-private-b', 'b.jpg');

    app = express();
    app.use(express.json());
    app.use('/api/secure-images', require('../../src/routes/secureImages'));
  }, 120000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  it('rejects a gallery-A token used against gallery B (cross-photo)', async () => {
    const token = mint(photoA, galleryA);
    const res = await view('secimg-private-b', photoB, token);
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/not valid for this photo/i);
  });

  it('rejects a gallery-A token replayed on gallery B with A\'s photoId', async () => {
    const token = mint(photoA, galleryA);
    // URL photoId matches the token, so the photo check passes — the gallery
    // check (sessionId gallery A != URL gallery B) must catch it.
    const res = await view('secimg-private-b', photoA, token);
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/not valid for this gallery/i);
  });

  it('lets a token read its own gallery + photo (binding passes)', async () => {
    const token = mint(photoA, galleryA);
    const res = await view('secimg-public-a', photoA, token);
    // Binding passes; serving may 200/404/500 depending on the pipeline, but
    // it must NOT be rejected as a token mismatch.
    expect(res.status).not.toBe(403);
  });
});
