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

  // name, type, archived_at, photo sizes, archive_size (the zip's own bytes)
  //
  // The zip sizes are deliberately in a DIFFERENT order from the summed photo
  // bytes, because that is the only way a test can tell which of the two the
  // route sorted by. Echo's zip size is null — an archive whose file could not
  // be measured.
  const fixtures = [
    ['Alpha Wedding', 'wedding', '2026-01-05T10:00:00.000Z', [300], 100],
    ['Bravo Birthday', 'birthday', '2026-02-05T10:00:00.000Z', [100], 900],
    ['Charlie Wedding', 'wedding', '2026-03-05T10:00:00.000Z', [500, 400], 50],
    ['Delta Corporate', 'corporate', '2026-04-05T10:00:00.000Z', [200], 400],
    ['Echo WEDDING Gala', 'wedding', '2026-05-05T10:00:00.000Z', [50], null],
    // Four rows that exist purely to pin LIKE-metacharacter handling: each
    // metacharacter name is paired with a name that a wildcard reading of it
    // would also match. Dated in 2025 so they sit at the tail of the default
    // newest-first ordering. None of them contains "wedding".
    ['Summer 100% Sale', 'party', '2025-01-05T10:00:00.000Z', [10], 1],
    ['Summer 100X Sale', 'party', '2025-02-05T10:00:00.000Z', [10], 2],
    ['Gala_Night', 'party', '2025-03-05T10:00:00.000Z', [10], 3],
    ['GalaXNight', 'party', '2025-04-05T10:00:00.000Z', [10], 4],
  ];

  // Every fixture's photo bytes and zip bytes, for the aggregate assertions.
  const ALL_PHOTOS = 10;
  const ALL_ARCHIVE_BYTES = 100 + 900 + 50 + 400 + 0 + 1 + 2 + 3 + 4;

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
    for (const [eventName, eventType, archivedAt, sizes, archiveSize] of fixtures) {
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
        archive_path: `events/archived/${slug}.zip`,
        archive_size: archiveSize,
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
      'GalaXNight', 'Gala_Night', 'Summer 100X Sale', 'Summer 100% Sale',
    ]);
    expect(body.pagination.total).toBe(9);
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
    expect(all.pagination.total).toBe(9);
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
    expect(names(page3)).toEqual(['Echo WEDDING Gala', 'GalaXNight']);
  });

  test('sortBy=size orders by the zip size — the number the Size column shows', async () => {
    const body = await list({ sortBy: 'size' });
    // Ordering by the summed photo bytes (what this did before
    // events.archive_size existed) would have produced Charlie / Alpha /
    // Delta / Bravo / Echo — a different list from the one on screen.
    expect(names(body).slice(0, 5)).toEqual([
      'Bravo Birthday',   // zip 900, photos 100
      'Delta Corporate',  // zip 400, photos 200
      'Alpha Wedding',    // zip 100, photos 300
      'Charlie Wedding',  // zip  50, photos 900
      'GalaXNight',       // zip   4
    ]);
    // The unmeasured zip sorts last, as the 0 it displays.
    expect(names(body).at(-1)).toBe('Echo WEDDING Gala');
  });

  test('archiveSize is the stored zip size, and 0 when it was never measured', async () => {
    const body = await list({ search: 'wedding' });
    const bySlug = Object.fromEntries(body.archives.map((a) => [a.eventName, a.archiveSize]));
    expect(bySlug['Alpha Wedding']).toBe(100);
    expect(bySlug['Charlie Wedding']).toBe(50);
    expect(bySlug['Echo WEDDING Gala']).toBe(0);
  });

  test('an unknown sortBy falls back to the date ordering', async () => {
    const body = await list({ sortBy: 'events.id; drop table events' });
    expect(names(body)[0]).toBe('Echo WEDDING Gala');
    expect(body.pagination.total).toBe(9);
  });

  test('quotes in the search are bound as a value, not injected as SQL', async () => {
    const body = await list({ search: '\'; DROP TABLE events; --' });
    expect(body.archives).toEqual([]);
    // The table is still there.
    expect((await list({})).pagination.total).toBe(9);
  });

  // --- LIKE metacharacters (C2) -------------------------------------------
  // `%` and `_` are wildcards in a LIKE pattern. An admin typing them into a
  // search box means them literally, so they are escaped in the bound value
  // and the pattern carries an explicit ESCAPE clause.

  test('a literal % matches only a literal %', async () => {
    const body = await list({ search: '100%' });
    expect(names(body)).toEqual(['Summer 100% Sale']);
    // Unescaped, "100%" is the prefix wildcard "100" and would also have
    // matched "Summer 100X Sale".
    expect(body.pagination.total).toBe(1);
  });

  test('a bare % is not a match-everything wildcard', async () => {
    const body = await list({ search: '%' });
    expect(names(body)).toEqual(['Summer 100% Sale']);
    expect(body.pagination.total).toBe(1);
  });

  test('a literal _ matches only a literal _', async () => {
    const body = await list({ search: 'gala_night' });
    expect(names(body)).toEqual(['Gala_Night']);
    // Unescaped, "_" is any single character and would also have matched
    // "GalaXNight".
    expect(body.pagination.total).toBe(1);
  });

  test('a backslash in the search is matched literally, not eaten as an escape', async () => {
    // Nothing in the fixtures contains a backslash. Without escaping the
    // escape character itself, "\%" would reach SQL as an escaped percent and
    // match every row on the engine that honours it.
    const body = await list({ search: '\\%' });
    expect(body.archives).toEqual([]);
    expect(body.pagination.total).toBe(0);
  });

  // --- Aggregates (C3) -----------------------------------------------------

  test('totals describe the whole filtered set, not the page', async () => {
    const body = await list({ limit: 2, page: 1 });
    expect(body.archives).toHaveLength(2);
    expect(body.totals).toEqual({
      archives: 9,
      photos: ALL_PHOTOS,
      archiveSize: ALL_ARCHIVE_BYTES,
    });

    // Same numbers from the last page — the stat cards must not move as the
    // admin pages through the list.
    const last = await list({ limit: 2, page: 5 });
    expect(last.totals).toEqual(body.totals);
  });

  test('totals respect the active search and type filter', async () => {
    const body = await list({ type: 'wedding' });
    expect(body.totals).toEqual({
      archives: 3,
      photos: 4,                 // Alpha 1 + Charlie 2 + Echo 1
      archiveSize: 100 + 50 + 0, // Echo's zip was never measured
    });

    const none = await list({ search: 'zzz-nothing' });
    expect(none.totals).toEqual({ archives: 0, photos: 0, archiveSize: 0 });
  });

  // --- Migration backfill (C1) ---------------------------------------------

  test('migration 197 backfills archive_size from the zip on disk', async () => {
    const migration = require('../../migrations/core/197_add_event_archive_size');
    const storagePath = process.env.STORAGE_PATH;
    await fs.promises.mkdir(path.join(storagePath, 'events/archived'), { recursive: true });
    await fs.promises.writeFile(path.join(storagePath, 'events/archived/backfill.zip'), Buffer.alloc(4096));

    const base = {
      event_type: 'wedding',
      event_name: 'Backfill Me',
      event_date: '2026-08-01',
      host_email: 'h@example.com',
      admin_email: 'a@example.com',
      password_hash: 'x',
      expires_at: new Date(Date.now() + 7 * 864e5).toISOString(),
      is_active: 0,
      is_archived: 1,
      is_draft: 0,
      archived_at: '2026-07-05T10:00:00.000Z',
      archive_size: null,
      created_at: new Date().toISOString(),
    };
    await db('events').insert([
      {
        ...base,
        slug: 'backfill-present',
        share_token: 'tok-backfill-present',
        share_link: '/gallery/backfill-present/tok-backfill-present',
        archive_path: 'events/archived/backfill.zip',
      },
      {
        ...base,
        slug: 'backfill-missing',
        share_token: 'tok-backfill-missing',
        share_link: '/gallery/backfill-missing/tok-backfill-missing',
        archive_path: 'events/archived/gone.zip',
      },
    ]);

    // Re-runnable by design: the column already exists, only the empty rows
    // are touched.
    await migration.up(db);

    const present = await db('events').where('slug', 'backfill-present').first();
    const missing = await db('events').where('slug', 'backfill-missing').first();
    expect(Number(present.archive_size)).toBe(4096);
    // A zip that cannot be statted stays NULL rather than claiming 0 bytes.
    expect(missing.archive_size).toBeNull();

    // A second run must not disturb the value it already wrote.
    await migration.up(db);
    expect(Number((await db('events').where('slug', 'backfill-present').first()).archive_size)).toBe(4096);

    await db('events').whereIn('slug', ['backfill-present', 'backfill-missing']).del();
  });
});
