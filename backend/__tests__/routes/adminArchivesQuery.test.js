/**
 * The archives list must resolve search / type filter / sort in SQL.
 *
 * Before this, GET /admin/archives ignored every query param except page and
 * limit: the UI fetched one 20-row page and filtered it in JavaScript while
 * the pagination footer kept reporting the unfiltered server-side total. An
 * archive that matched the search but lived on another page came back as a
 * false "0 results". These tests pin the params the route now honours, and
 * — the part that actually made the bug visible — that `pagination.total`
 * describes the *filtered* set.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-archquery-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'archquery-test-secret';

const request = require('supertest');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const { bootCrmDb, seedMinimal, buildRouteApp } = require('../integration/helpers/crmDb');

describe('GET /admin/archives query params (#I.01)', () => {
  let db; let cleanup; let app; let token;

  // name, type, archived_at, photo sizes
  const fixtures = [
    ['Alpha Wedding', 'wedding', '2026-01-05T10:00:00.000Z', [300]],
    ['Bravo Birthday', 'birthday', '2026-02-05T10:00:00.000Z', [100]],
    ['Charlie Wedding', 'wedding', '2026-03-05T10:00:00.000Z', [500, 400]],
    ['Delta Corporate', 'corporate', '2026-04-05T10:00:00.000Z', [200]],
    ['Echo WEDDING Gala', 'wedding', '2026-05-05T10:00:00.000Z', [50]],
  ];

  const list = async (query) => {
    const res = await request(app)
      .get('/admin/archives')
      .query(query)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    return res.body;
  };

  const names = (body) => body.archives.map((a) => a.eventName);

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    await seedMinimal(db);

    const role = await db('roles').where({ name: 'super_admin' }).first();
    const inserted = await db('admin_users').insert({
      username: 'arch-admin',
      email: 'arch-admin@example.com',
      password_hash: await bcrypt.hash('Passw0rd!', 4),
      role_id: role.id,
      is_active: 1,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).returning('id');
    const adminId = inserted[0]?.id ?? inserted[0];
    token = jwt.sign(
      { id: adminId, username: 'arch-admin', type: 'admin', role: 'super_admin', loginTime: Date.now() },
      process.env.JWT_SECRET,
      { expiresIn: '1h', issuer: 'picpeak-auth' },
    );

    let i = 0;
    for (const [eventName, eventType, archivedAt, sizes] of fixtures) {
      const slug = `arch-${i++}`;
      const ev = await db('events').insert({
        slug,
        event_type: eventType,
        event_name: eventName,
        event_date: '2026-08-01',
        host_email: 'h@example.com',
        admin_email: 'a@example.com',
        password_hash: 'x',
        share_token: `tok-${slug}`,
        share_link: `/gallery/${slug}/tok-${slug}`,
        expires_at: new Date(Date.now() + 7 * 864e5).toISOString(),
        is_active: 0,
        is_archived: 1,
        is_draft: 0,
        archived_at: archivedAt,
        created_at: new Date().toISOString(),
      }).returning('id');
      const eventId = ev[0]?.id ?? ev[0];

      let p = 0;
      for (const size of sizes) {
        await db('photos').insert({
          event_id: eventId,
          filename: `${slug}-${p++}.jpg`,
          path: `events/archived/${slug}.jpg`,
          type: 'individual',
          size_bytes: size,
          uploaded_at: new Date().toISOString(),
        });
      }
    }

    // A live event that must never surface in the archives list.
    await db('events').insert({
      slug: 'not-archived',
      event_type: 'wedding',
      event_name: 'Alpha Live Wedding',
      event_date: '2026-08-01',
      host_email: 'h@example.com',
      admin_email: 'a@example.com',
      password_hash: 'x',
      share_token: 'tok-not-archived',
      share_link: '/gallery/not-archived/tok-not-archived',
      expires_at: new Date(Date.now() + 7 * 864e5).toISOString(),
      is_active: 1,
      is_archived: 0,
      is_draft: 0,
      created_at: new Date().toISOString(),
    });

    app = buildRouteApp('/admin/archives', require('../../src/routes/adminArchives'));
  }, 120000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  test('no params: every archive, newest first, unfiltered total', async () => {
    const body = await list({});
    expect(names(body)).toEqual([
      'Echo WEDDING Gala', 'Delta Corporate', 'Charlie Wedding', 'Bravo Birthday', 'Alpha Wedding',
    ]);
    expect(body.pagination.total).toBe(5);
  });

  test('search filters in SQL and the total describes the filtered set', async () => {
    const body = await list({ search: 'wedding' });
    // Case-insensitive, matches "Echo WEDDING Gala" too, and never the
    // non-archived "Alpha Live Wedding".
    expect(names(body).sort()).toEqual(['Alpha Wedding', 'Charlie Wedding', 'Echo WEDDING Gala']);
    expect(body.pagination.total).toBe(3);
    expect(body.pagination.totalPages).toBe(1);
  });

  test('search reaches rows that are not on page 1 — the actual bug', async () => {
    // limit=2 puts "Alpha Wedding" (oldest) on page 3 of the unfiltered list.
    // Client-side filtering of page 1 returned nothing for this query.
    const body = await list({ search: 'alpha', limit: 2, page: 1 });
    expect(names(body)).toEqual(['Alpha Wedding']);
    expect(body.pagination.total).toBe(1);
  });

  test('search with no match returns an empty page and a zero total', async () => {
    const body = await list({ search: 'zzz-nothing' });
    expect(body.archives).toEqual([]);
    expect(body.pagination.total).toBe(0);
    expect(body.pagination.totalPages).toBe(0);
  });

  test('type filter narrows the rows and the total; "all" is a no-op', async () => {
    const filtered = await list({ type: 'wedding' });
    expect(names(filtered).sort()).toEqual(['Alpha Wedding', 'Charlie Wedding', 'Echo WEDDING Gala']);
    expect(filtered.pagination.total).toBe(3);

    const all = await list({ type: 'all' });
    expect(all.pagination.total).toBe(5);
  });

  test('search and type filter combine', async () => {
    const body = await list({ search: 'wedding', type: 'birthday' });
    expect(body.archives).toEqual([]);
    expect(body.pagination.total).toBe(0);
  });

  test('sortBy=name orders across the whole set, not just the page', async () => {
    const page1 = await list({ sortBy: 'name', limit: 2, page: 1 });
    expect(names(page1)).toEqual(['Alpha Wedding', 'Bravo Birthday']);

    const page3 = await list({ sortBy: 'name', limit: 2, page: 3 });
    expect(names(page3)).toEqual(['Echo WEDDING Gala']);
  });

  test('sortBy=size orders by archived content size, largest first', async () => {
    const body = await list({ sortBy: 'size' });
    expect(names(body)).toEqual([
      'Charlie Wedding',  // 900
      'Alpha Wedding',    // 300
      'Delta Corporate',  // 200
      'Bravo Birthday',   // 100
      'Echo WEDDING Gala' // 50
    ]);
  });

  test('an unknown sortBy falls back to the date ordering', async () => {
    const body = await list({ sortBy: 'events.id; drop table events' });
    expect(names(body)[0]).toBe('Echo WEDDING Gala');
    expect(body.pagination.total).toBe(5);
  });

  test('quotes in the search are bound as a value, not injected as SQL', async () => {
    const body = await list({ search: '\'; DROP TABLE events; --' });
    expect(body.archives).toEqual([]);
    // The table is still there.
    expect((await list({})).pagination.total).toBe(5);
  });
});
