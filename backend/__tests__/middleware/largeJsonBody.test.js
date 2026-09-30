/**
 * The 50 MB JSON parser used to run on /api/admin and /api/v1 before any
 * authentication, so anyone could make JSON.parse chew a 50 MB nested body.
 * largeJsonBody parses at the large limit only for a verified admin JWT or a
 * known API token; everything else falls through to the 2 MB parser and an
 * oversized body is refused with 413 unparsed (security review 2026-09-29).
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-largejson-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'largejson-test-secret-with-32-chars!!';
process.env.STORAGE_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-largejson-storage-'));

const zlib = require('zlib');
const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const { bootCrmDb, seedMinimal, mintAdminToken } = require('../integration/helpers/crmDb');
const { createLargeJsonBody } = require('../../src/middleware/largeJsonBody');

// 3 MB: over the small limit, under the large one.
const bigBody = JSON.stringify({ blob: 'x'.repeat(3 * 1024 * 1024) });
const smallBody = JSON.stringify({ blob: 'x' });

describe('largeJsonBody — the 50 MB parser is for authenticated callers only', () => {
  let db; let cleanup; let app; let adminId;
  const apiToken = 'pp_live_' + crypto.randomBytes(24).toString('hex');
  const revokedToken = 'pp_live_' + crypto.randomBytes(24).toString('hex');
  const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    ({ adminId } = await seedMinimal(db));
    await db('api_tokens').insert([
      { name: 'live', hashed_token: sha(apiToken), scopes: 'read', created_by: adminId },
      { name: 'revoked', hashed_token: sha(revokedToken), scopes: 'read', created_by: adminId, revoked_at: new Date().toISOString() },
    ]);
    app = express();
    app.use(cookieParser());
    app.use(['/api/admin', '/api/v1'], createLargeJsonBody({ limit: '50mb' }));
    app.use(express.json({ limit: '2mb' }));
    app.post('/api/admin/echo', (req, res) => res.json({ size: JSON.stringify(req.body).length }));
    app.post('/api/v1/echo', (req, res) => res.json({ size: JSON.stringify(req.body).length }));
    app.post('/api/other/echo', (req, res) => res.json({ size: JSON.stringify(req.body).length }));
  }, 120000);
  afterAll(async () => { if (cleanup) await cleanup(); });

  const post = (url) => request(app).post(url).set('Content-Type', 'application/json');

  it('refuses an oversized body from an unauthenticated caller with 413, on both prefixes', async () => {
    expect((await post('/api/admin/echo').send(bigBody)).status).toBe(413);
    expect((await post('/api/v1/echo').send(bigBody)).status).toBe(413);
  });

  it('still parses a small unauthenticated body through the ordinary parser', async () => {
    const res = await post('/api/admin/echo').send(smallBody);
    expect(res.status).toBe(200);
    expect(res.body.size).toBe(smallBody.length);
  });

  it('accepts the large body for a verified admin JWT, as a Bearer header and as the cookie', async () => {
    const token = mintAdminToken(adminId);
    const viaHeader = await post('/api/admin/echo').set('Authorization', `Bearer ${token}`).send(bigBody);
    expect(viaHeader.status).toBe(200);
    expect(viaHeader.body.size).toBe(bigBody.length);
    const viaCookie = await post('/api/admin/echo').set('Cookie', `admin_token=${token}`).send(bigBody);
    expect(viaCookie.status).toBe(200);
  });

  it('does not accept a forged or wrong-type token as proof', async () => {
    const forged = jwt.sign({ id: adminId, type: 'admin' }, 'not-the-secret', { issuer: 'picpeak-auth' });
    expect((await post('/api/admin/echo').set('Authorization', `Bearer ${forged}`).send(bigBody)).status).toBe(413);
    const gallery = jwt.sign({ id: 1, type: 'gallery' }, process.env.JWT_SECRET, { issuer: 'picpeak-auth' });
    expect((await post('/api/admin/echo').set('Authorization', `Bearer ${gallery}`).send(bigBody)).status).toBe(413);
  });

  it('accepts the large body for a known API token and refuses an unknown or revoked one', async () => {
    expect((await post('/api/v1/echo').set('Authorization', `Bearer ${apiToken}`).send(bigBody)).status).toBe(200);
    expect((await post('/api/v1/echo').set('Authorization', 'Bearer pp_live_' + 'f'.repeat(48)).send(bigBody)).status).toBe(413);
    expect((await post('/api/v1/echo').set('Authorization', `Bearer ${revokedToken}`).send(bigBody)).status).toBe(413);
  });

  it('never touches api_tokens unless the declared body could exceed the small limit', async () => {
    // The lookup is the only cost an unauthenticated caller can impose here,
    // and a made-up pp_live_ header must not buy one on every request.
    const seen = [];
    const onQuery = (q) => { if (/api_tokens/.test(q.sql)) seen.push(q.sql); };
    db.on('query', onQuery);
    try {
      const bogus = 'Bearer pp_live_' + 'e'.repeat(48);
      expect((await post('/api/v1/echo').set('Authorization', bogus).send(smallBody)).status).toBe(200);
      expect((await post('/api/admin/echo').set('Authorization', bogus).send(smallBody)).status).toBe(200);
      expect((await post('/api/v1/echo').set('Authorization', bogus).set('Content-Type', 'text/plain').send('x')).status).toBe(200);
      expect(seen).toHaveLength(0);
      expect((await post('/api/v1/echo').set('Authorization', bogus).send(bigBody)).status).toBe(413);
      expect(seen).toHaveLength(1);
    } finally {
      db.removeListener('query', onQuery);
    }
  });

  it('treats a compressed JSON body as possibly large, whatever its Content-Length says', async () => {
    // 3 MB of repetitive JSON gzips to a few KB. express.json inflates it and
    // applies the limit to the inflated size, so the small parser refuses it;
    // an authenticated caller must still get the large parser.
    const gz = zlib.gzipSync(Buffer.from(bigBody));
    expect(gz.length).toBeLessThan(64 * 1024);
    const token = mintAdminToken(adminId);
    // superagent would JSON-serialise a Buffer under this Content-Type and
    // corrupt the gzip stream; send the bytes as they are.
    const raw = (req) => req.serialize((d) => d);
    const ok = await raw(post('/api/admin/echo').set('Authorization', `Bearer ${token}`)
      .set('Content-Encoding', 'gzip')).send(gz);
    expect(ok.status).toBe(200);
    expect(ok.body.size).toBe(bigBody.length);
    const anon = await raw(post('/api/admin/echo').set('Content-Encoding', 'gzip')).send(gz);
    expect(anon.status).toBe(413);
  });

  it('leaves paths outside the two prefixes on the ordinary limit even when authenticated', async () => {
    const token = mintAdminToken(adminId);
    expect((await post('/api/other/echo').set('Authorization', `Bearer ${token}`).send(bigBody)).status).toBe(413);
  });
});
