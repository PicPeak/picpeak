/**
 * Gallery embed framing without nginx (issue 1112): the all-in-one image
 * serves the SPA from server.js. /gallery/:slug/embed/:token is the only page
 * another site may frame, and only while the embed is eligible: helmet's
 * X-Frame-Options goes, and frame-ancestors names the allowed websites. Every
 * other page, and an embed link that is not eligible, keeps SAMEORIGIN.
 *
 * Boots the real server.js with SERVE_FRONTEND=true against a stub build.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');
const { bootCrmDb } = require('./integration/helpers/crmDb');

const SLUG = 'embed-spa';
const TOKEN = 'c'.repeat(64);

let app; let db; let cleanup;

beforeAll(async () => {
  ({ db, cleanup } = await bootCrmDb());
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-embed-dist-'));
  fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>${BRAND_TITLE}</title><div id="root"></div>');
  process.env.SERVE_FRONTEND = 'true';
  process.env.FRONTEND_DIR = dist;
  // validateEnvironment (server.js require time) needs a 32+ char secret.
  process.env.JWT_SECRET = 'gallery-embed-spa-framing-test-secret-0123456789';
  process.env.PICPEAK_EVIDENCE_KEY = 'a'.repeat(64);

  await db('feature_flags').where({ key: 'embed' }).del();
  await db('feature_flags').insert({ key: 'embed', value: true });
  await db('events').insert({
    slug: SLUG, event_type: 'wedding', event_name: 'Embed SPA', event_date: '2026-08-01',
    host_email: 'host@example.com', admin_email: 'admin@example.com', password_hash: 'x', require_password: 0,
    share_link: `/gallery/${SLUG}/share`, share_token: 'embed-spa-share',
    embed_token: TOKEN, embed_allowed_origins: JSON.stringify(['https://example.com']),
    expires_at: new Date(Date.now() + 86400000).toISOString(),
    is_active: 1, is_archived: 0, is_draft: 0, created_at: new Date().toISOString(),
  });
  app = require('../server');
}, 120000);

afterAll(async () => { if (cleanup) await cleanup(); });

test('an eligible embed is frameable by the allowed websites only', async () => {
  const res = await request(app).get(`/gallery/${SLUG}/embed/${TOKEN}`);
  expect(res.status).toBe(200);
  expect(res.text).toContain('<div id="root">');
  expect(res.headers['x-frame-options']).toBeUndefined();
  expect(res.headers['content-security-policy']).toMatch(/frame-ancestors https:\/\/example\.com$/);
});

test('an embed link that is not eligible keeps SAMEORIGIN', async () => {
  const res = await request(app).get(`/gallery/${SLUG}/embed/${'d'.repeat(64)}`);
  expect(res.status).toBe(200);
  expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
  expect(res.headers['content-security-policy'] || '').not.toMatch(/frame-ancestors/);
});

test('the other gallery pages keep SAMEORIGIN', async () => {
  for (const uri of [`/gallery/${SLUG}`, `/gallery/${SLUG}/share`, `/gallery/${SLUG}/show/${TOKEN}`, '/admin']) {
    const res = await request(app).get(uri);
    expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
  }
});
