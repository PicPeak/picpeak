/**
 * HTTP round trip for cms_pages.show_in_footer on real SQLite:
 *   PUT /api/admin/cms/pages/:slug  →  GET /api/public/pages/:slug
 * SQLite hands knex booleans back as 0/1, so the public route has to
 * normalise them. The footer hooks read this response and their tests mock
 * the service, so only a route test against the real driver catches a
 * hidden page coming back as shown.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-public-cms-')), 'db.sqlite'
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'public-cms-test-secret';

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');
const { bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken } = require('../integration/helpers/crmDb');

describe('CMS show_in_footer through the public API (SQLite)', () => {
  let db; let cleanup; let app; let token;

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    const { adminId } = await seedMinimal(db);
    await assignAdminRole(db, adminId, 'super_admin');
    token = mintAdminToken(adminId);

    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/admin/cms', require('../../src/routes/adminCMS'));
    app.use('/api/public', require('../../src/routes/publicCMS'));
  }, 120000);

  afterAll(async () => { await cleanup(); });

  const setShown = (slug, show) => request(app)
    .put(`/api/admin/cms/pages/${slug}`)
    .set('Authorization', `Bearer ${token}`)
    .send({ show_in_footer: show });

  const publicFooterFlag = async (slug) => {
    const res = await request(app).get(`/api/public/pages/${slug}`);
    expect(res.status).toBe(200);
    return res.body.show_in_footer;
  };

  it('reports the AGB page that migration 316 ships hidden as hidden', async () => {
    const row = await db('cms_pages').where('slug', 'agb').first('show_in_footer');
    expect(row.show_in_footer).toBe(0); // the driver shape the route must handle
    expect(await publicFooterFlag('agb')).toBe(false);
  });

  it('round-trips hiding and showing a page set through the admin API', async () => {
    expect((await setShown('agb', true)).status).toBe(200);
    expect(await publicFooterFlag('agb')).toBe(true);

    expect((await setShown('agb', false)).status).toBe(200);
    expect(await publicFooterFlag('agb')).toBe(false);
  });
});
