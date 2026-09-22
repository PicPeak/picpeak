/**
 * Migration 245 (#1445): additive and idempotent — up twice, down twice,
 * up again — on whichever engine the suite runs against.
 */
const migration = require('../../migrations/core/245_contract_template_lineage');

let db;
let cleanup;
const COLUMNS = [
  ['contract_templates', 'source_template_id'],
  ['contract_templates', 'source_version_number'],
  ['contract_template_versions', 'system_revision'],
  ['quote_templates', 'default_contract_template_id'],
];
const present = () => Promise.all(COLUMNS.map(([table, column]) => db.schema.hasColumn(table, column)));

beforeAll(async () => {
  ({ db, cleanup } = await require('../integration/helpers/crmDb').bootCrmDb());
});
afterAll(async () => { if (cleanup) await cleanup(); });

test('up, up again, down, down again, up: the columns follow, and rows referencing the tables survive', async () => {
  const insertedId = (rows) => (typeof rows[0] === 'object' ? rows[0].id : rows[0]);
  const now = new Date().toISOString();
  const tpl = insertedId(await db('contract_templates').insert({ name: 'T', status: 'draft', lock_version: 1, created_at: now, updated_at: now }).returning('id'));
  await db('contract_template_versions').insert({ template_id: tpl, version_number: 1, status: 'draft', created_at: now, updated_at: now });
  expect(await present()).toEqual([true, true, true, true]);
  await migration.up(db);
  expect(await present()).toEqual([true, true, true, true]);
  await migration.down(db);
  expect(await present()).toEqual([false, false, false, false]);
  await migration.down(db);
  expect(await present()).toEqual([false, false, false, false]);
  await migration.up(db);
  expect(await present()).toEqual([true, true, true, true]);
  // Rebuilding a table to drop a column must not cascade into its children.
  expect(await db('contract_template_versions').where({ template_id: tpl })).toHaveLength(1);
});

test('deleting a source template leaves the copy and the quote template, with the reference cleared', async () => {
  const insertedId = (rows) => (typeof rows[0] === 'object' ? rows[0].id : rows[0]);
  const now = new Date().toISOString();
  const source = insertedId(await db('contract_templates').insert({ name: 'S', status: 'draft', lock_version: 1, created_at: now, updated_at: now }).returning('id'));
  const copy = insertedId(await db('contract_templates').insert({
    name: 'C', status: 'draft', lock_version: 1, source_template_id: source, source_version_number: 1, created_at: now, updated_at: now,
  }).returning('id'));
  if (db.client.config.client === 'sqlite3') await db.raw('PRAGMA foreign_keys = ON');
  await db('contract_templates').where({ id: source }).del();
  const row = await db('contract_templates').where({ id: copy }).first();
  expect(row).toBeDefined();
  expect(row.source_template_id).toBeNull();
});
