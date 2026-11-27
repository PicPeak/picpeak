/**
 * Migration 379 (website builder, issue 2618): idempotent, reversible, and
 * the per-gallery opt-in defaults to off for every existing gallery.
 */
const { bootCrmDb } = require('../integration/helpers/crmDb');
const migration = require('../../migrations/core/379_website_builder');

jest.setTimeout(120000);

let db; let cleanup;
beforeAll(async () => { ({ db, cleanup } = await bootCrmDb()); });
afterAll(async () => { if (cleanup) await cleanup(); });

test('creates the tables, the opt-in column and the flag, and a re-run changes nothing', async () => {
  expect(await db.schema.hasTable('website_documents')).toBe(true);
  expect(await db.schema.hasTable('website_assets')).toBe(true);
  expect(await db.schema.hasColumn('events', 'show_on_website')).toBe(true);
  await db('feature_flags').where({ key: 'websiteBuilder' }).update({ value: true });

  await migration.up(db);

  const flags = await db('feature_flags').where({ key: 'websiteBuilder' });
  expect(flags).toHaveLength(1);
  // A re-run keeps what the admin switched on.
  expect(Boolean(flags[0].value)).toBe(true);
});

test('existing galleries are not on the website', async () => {
  const [row] = await db('events').insert({
    slug: 'm379', event_type: 'wedding', event_name: 'M', event_date: '2026-01-01',
    host_email: 'h@example.com', admin_email: 'a@example.com', password_hash: 'x', share_link: 'm379',
    expires_at: new Date().toISOString(),
  }).returning('id');
  const event = await db('events').where({ id: row?.id ?? row }).first();
  expect(Boolean(event.show_on_website)).toBe(false);
});

test('down removes everything and up restores it', async () => {
  await migration.down(db);
  expect(await db.schema.hasTable('website_documents')).toBe(false);
  expect(await db.schema.hasTable('website_assets')).toBe(false);
  expect(await db.schema.hasColumn('events', 'show_on_website')).toBe(false);
  expect(await db('feature_flags').where({ key: 'websiteBuilder' }).first()).toBeUndefined();

  await migration.up(db);
  expect(await db.schema.hasTable('website_documents')).toBe(true);
  expect(await db.schema.hasColumn('events', 'show_on_website')).toBe(true);
  expect(Boolean((await db('feature_flags').where({ key: 'websiteBuilder' }).first()).value)).toBe(false);
});
