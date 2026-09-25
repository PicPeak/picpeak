/**
 * One event-ownership predicate (issue 1670, §2.4).
 *
 * The event sub-routers, the photo retry, the category reorder and the
 * feedback moderation each carried their own copy of "who may act on this
 * event": most as `if (req.admin.roleName === 'editor') where('created_by')`,
 * some as `!== 'super_admin'` plus a hand-written created_by comparison. The
 * rule that counts is canAccessEvent / scopeEventsQuery in
 * middleware/ownership — super_admin bypasses, everyone else gets their own
 * events plus ownerless ones. The event sub-routers sit behind
 * requireEventOwnership as well, and their copies differed from it: an editor
 * was refused an ownerless event the middleware had just let through. The
 * photo retry, the category reorder and the feedback moderation have no
 * middleware (keyed by photo, body or feedback id) and re-implemented the
 * same rule by hand; they now read it from the helper too.
 *
 * Two guards: the routers read the rule from the helper (source inspection),
 * and an editor is answered the same way by the middleware and by the handler
 * behind it.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-ownership-'));
process.env.STORAGE_PATH = tmp;
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-that-is-long-enough-for-validation';

const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcrypt');
const { bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken } = require('../integration/helpers/crmDb');

const ROUTES = path.join(__dirname, '../../src/routes');
const INSPECTED = [
  'adminEvents/crud.js', 'adminEvents/resets.js', 'adminEvents/logo.js', 'adminEvents/passwordRecovery.js',
  'adminEvents/downloadResolutions.js', 'adminEvents/downloadLimit.js', 'adminEvents/faces.js',
  'adminEvents/slideshow.js', 'adminPhotos.js', 'adminCategories.js', 'adminFeedback.js',
];

describe('the ownership rule is read from middleware/ownership, not re-implemented', () => {
  test.each(INSPECTED)('%s carries no inline created_by / editor-role scope', (rel) => {
    const src = fs.readFileSync(path.join(ROUTES, rel), 'utf8');
    // The shapes the copies took. A new one would be a fourth rule.
    expect(src).not.toMatch(/roleName === 'editor'/);
    expect(src).not.toMatch(/where\('created_by', req\.admin\.id\)/);
    expect(src).not.toMatch(/created_by !== req\.admin\.id/);
    expect(src).not.toMatch(/orWhere\('created_by', req\.admin\.id\)/);
    expect(src).toMatch(/require\('\.\.\/(?:\.\.\/)?middleware\/ownership'\)/);
  });
});

describe('an editor is answered alike by the middleware and the handler behind it', () => {
  let db; let cleanup; let app;
  let superId; let editorTok;
  let ownerless; let foreign; let own;

  const insertEvent = async (slug, createdBy) => {
    const ins = await db('events').insert({
      slug, event_type: 'wedding', event_name: slug,
      event_date: '2026-08-01', host_email: 'h@e.com', admin_email: 'a@e.com',
      password_hash: 'x', share_link: `/g/${slug}/s`, share_token: `${slug}-share`,
      expires_at: new Date(Date.now() + 7 * 864e5).toISOString(),
      is_active: 1, is_archived: 0, is_draft: 0, created_by: createdBy,
      created_at: new Date().toISOString(),
    }).returning('id');
    return ins[0]?.id ?? ins[0];
  };

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    ({ adminId: superId } = await seedMinimal(db));
    await assignAdminRole(db, superId, 'super_admin');

    const ins = await db('admin_users').insert({
      username: 'editor', email: 'editor@example.com',
      password_hash: await bcrypt.hash('x', 4), must_change_password: false, created_at: new Date(),
    }).returning('id');
    const editorId = ins[0]?.id ?? ins[0];
    await assignAdminRole(db, editorId, 'editor');
    editorTok = mintAdminToken(editorId);

    ownerless = await insertEvent('own-legacy', null);
    foreign = await insertEvent('own-foreign', superId);
    own = await insertEvent('own-mine', editorId);

    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/admin/events', require('../../src/routes/adminEvents'));
    // eslint-disable-next-line no-unused-vars
    app.use((err, req, res, next) => {
      res.status(err.statusCode || err.status || 500).json({ error: err.message, code: err.code });
    });
  }, 120000);

  afterAll(async () => {
    if (cleanup) await cleanup();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const get = (url) => request(app).get(url).set('Authorization', `Bearer ${editorTok}`);

  // requireEventOwnership lets an editor through to an ownerless (legacy /
  // system) event. The handler's own copy of the rule used to answer 404 right
  // after — the middleware and the handler disagreed on the same request.
  test.each([
    ['/password-status'],
    ['/download-resolutions'],
  ])('an ownerless event answers 200 on GET /:id%s', async (suffix) => {
    const res = await get(`/api/admin/events/${ownerless}${suffix}`);
    expect(res.status).toBe(200);
  });

  test.each([
    ['/password-status'],
    ['/download-resolutions'],
  ])('an own event answers 200 on GET /:id%s', async (suffix) => {
    const res = await get(`/api/admin/events/${own}${suffix}`);
    expect(res.status).toBe(200);
  });

  test.each([
    ['/password-status'],
    ['/download-resolutions'],
  ])('a foreign event is still refused on GET /:id%s', async (suffix) => {
    const res = await get(`/api/admin/events/${foreign}${suffix}`);
    expect(res.status).toBe(403);
  });
});
