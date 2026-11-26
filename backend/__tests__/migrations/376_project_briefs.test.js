/**
 * Migration 376 completes an interrupted run: SQLite runs a migration without
 * a transaction, so a run can stop between a table and its indexes, or between
 * the update mail and its translations.
 */
const { bootCrmDb } = require('../integration/helpers/crmDb');
const migration = require('../../migrations/core/376_project_briefs');

jest.setTimeout(120000);

let db; let cleanup;
beforeAll(async () => { ({ db, cleanup } = await bootCrmDb()); });
afterAll(async () => { if (cleanup) await cleanup(); });

const indexExists = async (name) => !!(await db('sqlite_master').where({ type: 'index', name }).first());

test('recreates a unique index the interrupted run did not get to', async () => {
  await db.raw('DROP INDEX project_briefs_project_id_unique');
  await db.raw('DROP INDEX project_brief_values_brief_id_field_id_unique');
  await migration.up(db);
  expect(await indexExists('project_briefs_project_id_unique')).toBe(true);
  expect(await indexExists('project_brief_values_brief_id_field_id_unique')).toBe(true);
});

test('adds the missing translations of the update mail and keeps edited ones', async () => {
  const template = await db('email_templates').where({ template_key: 'project_brief_updated' }).first('id');
  await db('email_template_translations').where({ template_id: template.id, language: 'fr' }).del();
  await db('email_template_translations').where({ template_id: template.id, language: 'de' }).update({ subject: 'Edited by the studio' });
  await migration.up(db);
  const rows = await db('email_template_translations').where({ template_id: template.id });
  expect(rows.map((r) => r.language).sort()).toEqual(['de', 'en', 'es', 'fr', 'nl', 'pt', 'ru', 'sl']);
  expect(rows.find((r) => r.language === 'de').subject).toBe('Edited by the studio');
  expect(rows.find((r) => r.language === 'fr').subject).toBe(migration.TRANSLATIONS.fr.subject);
});
