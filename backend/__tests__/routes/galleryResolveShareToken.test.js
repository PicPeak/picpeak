/**
 * GHSA-rh8r-7x3h-36rv — the unauthenticated GET /api/gallery/resolve/:identifier
 * must NOT return a gallery's secret share_token (nor the share links that
 * embed it) for a bare *slug* lookup. Slugs appear in gallery URLs and are
 * guessable; handing back the secret turns a known slug into share-link
 * access to a no-password gallery. The token is only returned when the caller
 * resolved via the token / full share link (i.e. already holds it).
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-resolve-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'resolve-test-secret';
process.env.STORAGE_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-resolve-storage-'));

const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const { bootCrmDb, seedMinimal } = require('../integration/helpers/crmDb');

const SLUG = 'resolve-test-event';
const SHARE_TOKEN = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';

describe('GET /api/gallery/resolve/:identifier (GHSA-rh8r)', () => {
  let db; let cleanup; let app;

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    await seedMinimal(db);
    await db('events').insert({
      slug: SLUG,
      event_type: 'wedding',
      event_name: 'Resolve Test',
      event_date: '2026-08-01',
      host_email: 'h@example.com',
      admin_email: 'a@example.com',
      password_hash: 'x',
      share_link: `/gallery/${SLUG}/${SHARE_TOKEN}`,
      share_token: SHARE_TOKEN,
      require_password: 0, // no-password → the token IS the access credential
      expires_at: new Date(Date.now() + 7 * 864e5).toISOString(),
      is_active: 1, is_archived: 0, is_draft: 0,
      created_at: new Date().toISOString(),
    });

    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/gallery', require('../../src/routes/gallery'));
  }, 120000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  it('does NOT leak the share_token (or share links) for a bare slug lookup', async () => {
    const res = await request(app).get(`/api/gallery/resolve/${SLUG}`);
    expect(res.status).toBe(200);
    expect(res.body.slug).toBe(SLUG);
    expect(res.body.matchType).toBe('slug');
    // The secret must be absent — and must not sneak out via the share links.
    expect(res.body.token).toBeUndefined();
    expect(res.body.share_link).toBeUndefined();
    expect(res.body.share_url).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain(SHARE_TOKEN);
  });

  it('DOES return the token when the caller already resolved via the token', async () => {
    const res = await request(app).get(`/api/gallery/resolve/${SHARE_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.token).toBe(SHARE_TOKEN);
    expect(res.body.matchType).toMatch(/token/);
  });

  it('does NOT leak the token via SQL LIKE wildcards in the link_partial fallback', async () => {
    // Before the escaping fix, an anonymous request of 32 underscores matched
    // any share_link ending in a 32-char token (`_` = single-char wildcard),
    // resolved as matchType 'link_partial', and handed back the bearer token.
    // The share_token here has no underscores, so an escaped LIKE must miss.
    const res = await request(app).get(`/api/gallery/resolve/${'_'.repeat(SHARE_TOKEN.length)}`);
    expect(res.status).toBe(404);
    expect(res.body.token).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain(SHARE_TOKEN);
  });
});
