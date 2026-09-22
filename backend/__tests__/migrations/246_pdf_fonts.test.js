/**
 * Migration 246 (#1445): the uploaded-font tables — up twice, down twice,
 * up again — and a font with files can't be deleted from under them.
 */
const migration = require('../../migrations/core/246_pdf_fonts');

let db;
let cleanup;
const tables = () => Promise.all(['pdf_fonts', 'pdf_font_files'].map((t) => db.schema.hasTable(t)));

beforeAll(async () => {
  ({ db, cleanup } = await require('../integration/helpers/crmDb').bootCrmDb());
});
afterAll(async () => { if (cleanup) await cleanup(); });

test('up, up again, down, down again, up', async () => {
  expect(await tables()).toEqual([true, true]);
  await migration.up(db);
  expect(await tables()).toEqual([true, true]);
  await migration.down(db);
  expect(await tables()).toEqual([false, false]);
  await migration.down(db);
  expect(await tables()).toEqual([false, false]);
  await migration.up(db);
  expect(await tables()).toEqual([true, true]);
});

test('one file per style, and a font with files is not deleted', async () => {
  const now = new Date().toISOString();
  const inserted = await db('pdf_fonts').insert({ display_name: 'X', licence_note: 'n', created_at: now, updated_at: now }).returning('id');
  const fontId = inserted[0]?.id ?? inserted[0];
  const file = { font_id: fontId, style: '400', storage_key: 'business-docs/fonts/a.ttf', sha256: 'a'.repeat(64), bytes: 1, created_at: now };
  await db('pdf_font_files').insert(file);
  await expect(db('pdf_font_files').insert(file)).rejects.toThrow();
  await expect(db('pdf_fonts').insert({ display_name: 'X', licence_note: 'n', created_at: now, updated_at: now })).rejects.toThrow();
  if (db.client.config.client === 'sqlite3') await db.raw('PRAGMA foreign_keys = ON');
  await expect(db('pdf_fonts').where({ id: fontId }).del()).rejects.toThrow();
});
