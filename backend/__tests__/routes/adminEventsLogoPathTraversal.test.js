/**
 * GHSA-9q5j-vqfw-32hr — the event-logo upload's multer `filename` callback
 * built the stored path directly from `req.params.id` with no integer
 * validation:
 *
 *   filename: (req, file, cb) => {
 *     cb(null, `event-${req.params.id}-logo-${Date.now()}${ext}`);
 *   }
 *
 * A traversal payload in the `:id` route param (URL-encoded so it still
 * matches a single Express path segment, then decoded back into literal
 * `../` sequences by Express before handlers see it) could escape the
 * intended uploads/logos/events/ directory. Most directly reachable via a
 * super_admin session: requireEventOwnership short-circuits with next() and
 * zero DB lookup for that role (src/middleware/ownership.js), so nothing
 * upstream of multer validates the id first.
 *
 * Fixed by rejecting any non-positive-integer id before it is used to build
 * the filename, regardless of role or ownership-check ordering.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-events-logo-')), 'db.sqlite'
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'admin-events-logo-test-secret';

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');
const { bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken } = require('../integration/helpers/crmDb');

async function insertEvent(db, adminId, over = {}) {
  const base = {
    slug: `ev-${Math.random().toString(16).slice(2)}`,
    event_type: 'wedding',
    event_name: 'Test Wedding',
    event_date: '2026-05-29',
    host_email: 'host@example.com',
    admin_email: 'admin@example.com',
    password_hash: 'x',
    share_link: `/gallery/share-${Math.random().toString(16).slice(2)}`,
    share_token: `st-${Math.random().toString(16).slice(2)}`,
    expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
    is_active: 1, is_archived: 0, is_draft: 0,
    created_by: adminId,
    created_at: new Date().toISOString(),
    ...over,
  };
  const r = await db('events').insert(base).returning('id');
  return r[0]?.id ?? r[0];
}

describe('POST /api/admin/events/:id/logo — path traversal guard', () => {
  let db; let cleanup; let app; let adminId; let token;

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    ({ adminId } = await seedMinimal(db));
    // super_admin: requireEventOwnership short-circuits with no DB lookup
    // for this role, so it reaches multer with nothing upstream having
    // validated the id — the exact path GHSA-9q5j-vqfw-32hr exploited.
    await assignAdminRole(db, adminId, 'super_admin');
    token = mintAdminToken(adminId);

    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/admin/events', require('../../src/routes/adminEvents'));
    // eslint-disable-next-line no-unused-vars
    app.use((err, req, res, next) => {
      res.status(err.statusCode || err.status || 500).json({ error: err.message, code: err.code });
    });
  }, 120000);

  afterAll(async () => { await cleanup(); });

  const auth = (req) => req.set('Authorization', `Bearer ${token}`);
  const logoDir = () => path.join(process.env.STORAGE_PATH, 'uploads/logos/events');

  it('rejects a traversal payload in the id param instead of writing outside uploads/logos/events', async () => {
    // '../../../../tmp/pwned' URL-encoded so the raw request path still has
    // a single segment (matches Express's `:id`), but Express decodes the
    // param back into literal '../' sequences before the route sees it.
    const traversalId = encodeURIComponent('../../../../tmp/pwned');

    const res = await auth(
      request(app).post(`/api/admin/events/${traversalId}/logo`)
    ).attach('logo', Buffer.from('fake image data'), 'logo.png');

    // Refused before the upload either way: the event ownership check takes
    // only a plain integer id, and the route's own filename check stays
    // behind it as a second line.
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body.error).toMatch(/invalid event id|event not found/i);

    // No file should have been written anywhere — the filename callback
    // must error out before multer opens a write stream.
    const escapedFile = path.join(os.tmpdir(), 'pwned');
    expect(fs.existsSync(escapedFile)).toBe(false);
    if (fs.existsSync(logoDir())) {
      expect(fs.readdirSync(logoDir())).toHaveLength(0);
    }
  });

  it('still accepts a normal numeric event id', async () => {
    const id = await insertEvent(db, adminId, { event_name: 'Logo Event' });

    const res = await auth(
      request(app).post(`/api/admin/events/${id}/logo`)
    ).attach('logo', Buffer.from('fake image data'), 'logo.png');

    expect(res.status).toBe(200);
    expect(res.body.hero_logo_url).toMatch(new RegExp(`^/uploads/logos/events/event-${id}-logo-`));

    const files = fs.readdirSync(logoDir());
    expect(files.some((f) => f.startsWith(`event-${id}-logo-`))).toBe(true);

    const row = await db('events').where({ id }).first();
    expect(row.hero_logo_url).toBe(res.body.hero_logo_url);
  });
});
