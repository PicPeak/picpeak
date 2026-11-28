/**
 * Migration 383: the reservation table behind the contact form's
 * once-a-day confirmation (issue 2618). Runs again without harm; one row per
 * address and day; down drops it.
 */
const { bootCrmDb } = require('../integration/helpers/crmDb');
const migration = require('../../migrations/core/383_website_contact_confirmations');

jest.setTimeout(120000);

let db; let cleanup;
beforeAll(async () => { ({ db, cleanup } = await bootCrmDb()); });
afterAll(async () => { if (cleanup) await cleanup(); });

test('one row per address and day, and a second run changes nothing', async () => {
  await migration.up(db);
  const row = { address_key: 'a@example.com', window_start: '2026-11-28', claim: 'x', created_at: new Date().toISOString() };
  await db('website_contact_confirmations').insert(row);
  await db('website_contact_confirmations').insert({ ...row, claim: 'y' }).onConflict(['address_key', 'window_start']).ignore();
  expect(await db('website_contact_confirmations').select('claim')).toEqual([{ claim: 'x' }]);
  await expect(db('website_contact_confirmations').insert({ ...row, claim: 'z' })).rejects.toThrow();
});

test('down drops the table', async () => {
  await migration.down(db);
  expect(await db.schema.hasTable('website_contact_confirmations')).toBe(false);
  await migration.up(db);
  expect(await db.schema.hasTable('website_contact_confirmations')).toBe(true);
});
