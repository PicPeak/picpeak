/**
 * "Date Taken" ordering across SQLite's storage classes (#1172).
 *
 * photos.captured_at does not hold one type on SQLite. Three writers put three
 * different things in it:
 *
 *   integer  managed uploads — photoProcessor.js:441 hands knex a Date, which
 *            the sqlite3 binding stores as epoch milliseconds
 *   text     external imports and the capture-date backfill, which write
 *            ISO-8601 ('2026-06-03T01:15:00.000Z')
 *   null     no capture date, so the sort falls through to uploaded_at —
 *            itself text, in knex's 'YYYY-MM-DD HH:MM:SS' shape
 *
 * A plain COALESCE over that mixture is not an ordering. SQLite sorts INTEGER
 * before TEXT unconditionally, so every managed photo carrying EXIF came back
 * ahead of every photo that did not, whatever the dates said. And among the
 * text values 'T' (0x54) outranks the space (0x20), so a same-day ISO 01:15
 * sorted behind a fallback 23:00.
 *
 * Both failures predate #1172 — the first needs only two managed photos — but
 * the sort is what that issue is about, so they are fixed and pinned here.
 * Every test below fails on the unfixed ORDER BY.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-capsort-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'capsort-test-secret';
process.env.STORAGE_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-capsort-storage-'));

const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const { bootCrmDb, seedMinimal } = require('../integration/helpers/crmDb');

const SLUG = 'capsort-gallery';

describe('capture-date ordering on SQLite (#1172)', () => {
  let db; let cleanup; let app; let eventId;

  // Managed uploads store an epoch-millisecond INTEGER, because
  // photoProcessor.js:441 hands knex a Date and the sqlite3 binding converts
  // it. That conversion cannot be reproduced from inside jest — there the
  // binding's type dispatch misses sandbox-created Dates and writes the string
  // "[object Object]" instead (CLAUDE.md). Verified outside jest: a Date lands
  // as {"c":1830211200000,"ty":"integer"}. So these tests write the integer
  // production would have written, rather than a Date that jest mangles.
  const managed = (iso) => new Date(iso).getTime();

  const addPhoto = async (filename, capturedAt, uploadedAt) => {
    const row = await db('photos').insert({
      event_id: eventId,
      filename,
      path: `${SLUG}/${filename}`,
      type: 'individual',
      captured_at: capturedAt,
      uploaded_at: uploadedAt,
    }).returning('id');
    return row[0]?.id ?? row[0];
  };

  const orderedFilenames = async (order = 'asc') => {
    const res = await request(app).get(`/api/gallery/${SLUG}/photos?sort=capture_date&order=${order}`);
    expect(res.status).toBe(200);
    return res.body.photos.map((p) => p.filename);
  };

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    await seedMinimal(db);

    const ev = await db('events').insert({
      slug: SLUG,
      event_type: 'wedding',
      event_name: 'Capture Sort',
      event_date: '2026-08-01',
      host_email: 'h@example.com',
      admin_email: 'a@example.com',
      password_hash: 'x',
      share_link: `/gallery/${SLUG}/s`,
      share_token: 'capsort-share',
      expires_at: new Date(Date.now() + 7 * 864e5).toISOString(),
      is_active: 1,
      is_archived: 0,
      is_draft: 0,
      require_password: 0,
      created_at: new Date().toISOString(),
    }).returning('id');
    eventId = ev[0]?.id ?? ev[0];

    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/gallery', require('../../src/routes/gallery'));
  }, 120000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  beforeEach(async () => { await db('photos').where({ event_id: eventId }).del(); });

  test('the fixture really does put three storage classes in one column', async () => {
    expect(['sqlite3', 'better-sqlite3']).toContain(db.client.config.client);
    await addPhoto('m.jpg', managed('2026-06-03T01:15:00Z'), '2026-01-01 00:00:00');
    await addPhoto('e.jpg', '2020-01-01T00:00:00.000Z', '2026-01-01 00:00:00');
    await addPhoto('n.jpg', null, '2026-01-01 00:00:00');

    const rows = await db.raw('select filename, typeof(captured_at) as t from photos order by filename');
    const byName = Object.fromEntries((rows.rows || rows).map((r) => [r.filename, r.t]));
    // Exactly the mixture that made COALESCE meaningless.
    expect(byName).toEqual({ 'm.jpg': 'integer', 'e.jpg': 'text', 'n.jpg': 'null' });
  });

  test('a managed EXIF date does not outrank an earlier one stored as text', async () => {
    // The pre-existing failure, reachable with managed photos alone: integer
    // beat text regardless of the dates, so this came back exactly reversed.
    await addPhoto('managed-2027.jpg', managed('2027-12-31T00:00:00Z'), '2026-01-01 00:00:00');
    await addPhoto('external-2020.jpg', '2020-01-01T00:00:00.000Z', '2026-01-01 00:00:00');

    expect(await orderedFilenames('asc')).toEqual(['external-2020.jpg', 'managed-2027.jpg']);
    expect(await orderedFilenames('desc')).toEqual(['managed-2027.jpg', 'external-2020.jpg']);
  });

  test('a photo with no capture date sorts by its upload time, not ahead of everything', async () => {
    await addPhoto('has-exif-2027.jpg', managed('2027-12-31T00:00:00Z'), '2027-12-31 00:00:00');
    await addPhoto('no-exif-2020.jpg', null, '2020-01-01 00:00:00');

    expect(await orderedFilenames('asc')).toEqual(['no-exif-2020.jpg', 'has-exif-2027.jpg']);
  });

  test('an ISO capture time and a fallback upload time compare by clock, not by separator', async () => {
    // Same day: 'T' vs ' ' decided this before, so 01:15 sorted after 23:00.
    await addPhoto('iso-0115.jpg', '2026-06-03T01:15:00.000Z', '2026-06-03 05:00:00');
    await addPhoto('fallback-2300.jpg', null, '2026-06-03 23:00:00');

    expect(await orderedFilenames('asc')).toEqual(['iso-0115.jpg', 'fallback-2300.jpg']);
  });

  test('an epoch-integer uploaded_at is compared as a date, not as its digits', async () => {
    // uploaded_at is not always text either: a legacy archive restore leaves
    // epoch milliseconds in it (a .picpeak restore from an install that stored them that way).
    // Reading that with substr() would have compared the string '1830297600000'
    // against '2020-01-01 00:00:00', putting the 2028 row first.
    await addPhoto('epoch-upload-2028.jpg', null, new Date('2028-01-01T00:00:00Z').getTime());
    await addPhoto('captured-2020.jpg', managed('2020-01-01T00:00:00Z'), '2020-01-01 00:00:00');

    const [row] = await db.raw('select typeof(uploaded_at) as t from photos where filename = \'epoch-upload-2028.jpg\'');
    expect((row.t || row).toString()).toBe('integer');

    expect(await orderedFilenames('asc')).toEqual(['captured-2020.jpg', 'epoch-upload-2028.jpg']);
  });

  test('all three storage classes order together correctly', async () => {
    await addPhoto('c-managed-2026-08.jpg', managed('2026-08-15T12:00:00Z'), '2026-09-01 00:00:00');
    await addPhoto('a-external-2026-06.jpg', '2026-06-03T01:15:00.000Z', '2026-09-01 00:00:00');
    await addPhoto('d-fallback-2026-09.jpg', null, '2026-09-01 00:00:00');
    await addPhoto('b-managed-2026-07.jpg', managed('2026-07-04T09:30:00Z'), '2026-09-01 00:00:00');

    expect(await orderedFilenames('asc')).toEqual([
      'a-external-2026-06.jpg',
      'b-managed-2026-07.jpg',
      'c-managed-2026-08.jpg',
      'd-fallback-2026-09.jpg',
    ]);
  });
});
