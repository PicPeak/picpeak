/**
 * Regression test for clearing an event's expiration on SQLite (#1029).
 *
 * Migration 061 dropped the NOT NULL on events.event_date / events.expires_at
 * for Postgres only — it skipped SQLite on the (wrong) premise that SQLite
 * doesn't enforce NOT NULL. It does, so every SQLite install answered
 *
 *     SQLITE_CONSTRAINT: NOT NULL constraint failed: events.expires_at
 *
 * when an admin cleared the expiration, surfacing as "Failed to update event".
 * Migration 174 finishes the job. The harness runs on SQLite, so this asserts
 * the real engine behaviour rather than a mock.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-nullable-dates-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'nullable-dates-test-secret';

const { bootCrmDb, seedMinimal } = require('../integration/helpers/crmDb');

let db;
let cleanup;
let eventId;

beforeAll(async () => {
  ({ db, cleanup } = await bootCrmDb());
  await seedMinimal(db);
  const inserted = await db('events').insert({
    slug: 'nullable-dates-test',
    event_type: 'wedding',
    event_name: 'Nullable Dates Test',
    event_date: '2026-06-22',
    host_email: 'host@example.com',
    admin_email: 'admin@example.com',
    password_hash: 'x',
    share_link: '/gallery/nullable-dates-test/share',
    share_token: 'nullable-dates-share',
    expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
    is_active: 1,
    is_archived: 0,
    is_draft: 0,
    created_at: new Date().toISOString(),
  }).returning('id');
  eventId = inserted[0]?.id ?? inserted[0];
}, 120000);

afterAll(async () => { if (cleanup) await cleanup(); });

describe('events date columns are nullable on SQLite (#1029)', () => {
  test('the engine under test really is SQLite', () => {
    expect(['sqlite3', 'better-sqlite3']).toContain(db.client.config.client);
  });

  test('clearing expires_at succeeds — this threw SQLITE_CONSTRAINT before migration 174', async () => {
    await db('events').where('id', eventId).update({ expires_at: null });
    const row = await db('events').where('id', eventId).first('expires_at');
    expect(row.expires_at).toBeNull();
  });

  test('clearing event_date succeeds too (061 covered both columns on PG)', async () => {
    await db('events').where('id', eventId).update({ event_date: null });
    const row = await db('events').where('id', eventId).first('event_date');
    expect(row.event_date).toBeNull();
  });

  test('a gallery can be created with no expiration at all', async () => {
    const inserted = await db('events').insert({
      slug: 'never-expires-test',
      event_type: 'other',
      event_name: 'Never Expires',
      event_date: null,
      host_email: 'host@example.com',
      admin_email: 'admin@example.com',
      password_hash: 'x',
      share_link: '/gallery/never-expires-test/share',
      share_token: 'never-expires-share',
      expires_at: null,
      is_active: 1,
      is_archived: 0,
      is_draft: 0,
      created_at: new Date().toISOString(),
    }).returning('id');
    const id = inserted[0]?.id ?? inserted[0];
    const row = await db('events').where('id', id).first('expires_at', 'event_date');
    expect(row.expires_at).toBeNull();
    expect(row.event_date).toBeNull();
  });

  test('columns the events table depends on survived the table rebuild', async () => {
    // Knex implements .alter() on SQLite by recreating the table; make sure the
    // rebuild kept the row and the wider schema intact.
    const row = await db('events').where('id', eventId).first();
    expect(row.slug).toBe('nullable-dates-test');
    expect(row.share_token).toBe('nullable-dates-share');
    expect(await db.schema.hasColumn('events', 'allow_downloads')).toBe(true);
    expect(await db.schema.hasColumn('events', 'hero_photo_id')).toBe(true);
    const photos = await db('photos').where('event_id', eventId);
    expect(Array.isArray(photos)).toBe(true);
  });
});
