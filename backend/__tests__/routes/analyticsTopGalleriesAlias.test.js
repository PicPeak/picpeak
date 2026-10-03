/**
 * /analytics topGalleries carries a `uniqueVisitors` column built with
 * db.raw(). Postgres folds an unquoted identifier to lower case, so the
 * old `as uniqueVisitors` came back as `uniquevisitors`, the frontend's
 * `gallery.uniqueVisitors || gallery.views` fell through, and the page
 * showed every view as a unique visitor. SQLite keeps the case as written
 * and never showed it.
 *
 * The suite runs on SQLite, so the response shape is checked for real and
 * the Postgres half is pinned by asserting that the SQL knex emits quotes
 * the alias — db.raw passes the fragment through verbatim on both engines.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-analytics-alias-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'analytics-alias-test-secret';

const request = require('supertest');
const express = require('express');

const { bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken } = require('../integration/helpers/crmDb');

describe('GET /api/admin/dashboard/analytics — topGalleries uniqueVisitors alias', () => {
  let db; let cleanup; let app; let token;

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    const { adminId } = await seedMinimal(db);
    await assignAdminRole(db, adminId, 'super_admin');
    token = mintAdminToken(adminId);

    const inserted = await db('events').insert({
      slug: 'alias-gallery',
      event_type: 'wedding',
      event_name: 'Alias Gallery',
      event_date: '2026-08-01',
      host_email: 'h@example.com',
      admin_email: 'a@example.com',
      password_hash: 'x',
      share_token: 'tok-alias',
      share_link: '/gallery/alias-gallery/tok-alias',
      created_by: adminId,
      expires_at: new Date(Date.now() + 7 * 864e5).toISOString(),
      is_active: 1, is_archived: 0, is_draft: 0,
      created_at: new Date().toISOString(),
    }).returning('id');
    const eventId = inserted[0]?.id ?? inserted[0];

    // Three views from two addresses: views=3, uniqueVisitors=2.
    for (const ip of ['10.0.0.1', '10.0.0.1', '10.0.0.2']) {
      await db('access_logs').insert({
        event_id: eventId,
        action: 'view',
        ip_address: ip,
        user_agent: 'Mozilla/5.0',
        timestamp: new Date().toISOString(),
      });
    }

    app = express();
    app.use(express.json());
    app.use('/api/admin/dashboard', require('../../src/routes/adminDashboard'));
  }, 120000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  it('quotes the alias in the emitted SQL and returns it under its camelCase name', async () => {
    const seen = [];
    const onQuery = (q) => { seen.push(q.sql); };
    db.on('query', onQuery);
    let res;
    try {
      res = await request(app)
        .get('/api/admin/dashboard/analytics?days=7')
        .set('Authorization', `Bearer ${token}`);
    } finally {
      db.removeListener('query', onQuery);
    }

    expect(res.status).toBe(200);
    const [gallery] = res.body.topGalleries;
    expect(gallery.slug).toBe('alias-gallery');
    expect(Number(gallery.views)).toBe(3);
    expect(Number(gallery.uniqueVisitors)).toBe(2);
    expect(gallery).not.toHaveProperty('uniquevisitors');

    const topGalleriesSql = seen.find((sql) => sql.includes('as "uniqueVisitors"'));
    expect(topGalleriesSql).toBeDefined();
    expect(seen.some((sql) => /as uniqueVisitors\b/.test(sql))).toBe(false);
  });
});
