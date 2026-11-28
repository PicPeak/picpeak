/**
 * Migration 384 (issue 2618): the visitor's confirmation carries no text the
 * visitor typed, so the default templates lose {{sender_name}} (a template
 * the studio edited stays as it is), and the confirmation reservation's
 * address key holds 255 characters.
 */
const { bootCrmDb } = require('../integration/helpers/crmDb');
const migration = require('../../migrations/core/384_website_contact_hardening');
const m382 = require('../../migrations/core/382_website_contact_emails');

jest.setTimeout(120000);

let db; let cleanup;
beforeAll(async () => { ({ db, cleanup } = await bootCrmDb()); });
afterAll(async () => { if (cleanup) await cleanup(); });

const translations = async () => {
  const template = await db('email_templates').where({ template_key: 'website_contact_confirmation' }).first('id', 'variables');
  return { template, rows: await db('email_template_translations').where({ template_id: template.id }) };
};

test('the default confirmation texts carry no visitor text', async () => {
  const { template, rows } = await translations();
  expect(rows).toHaveLength(3);
  for (const row of rows) expect(`${row.subject}${row.body_html}${row.body_text}`).not.toContain('{{sender_name}}');
  expect(JSON.parse(template.variables)).toEqual(['business_name']);
});

test('a translation the studio edited stays, an untouched default is replaced, and a second run changes nothing', async () => {
  const { template } = await translations();
  const old = m382.TEMPLATES.website_contact_confirmation.translations;
  await db('email_template_translations').where({ template_id: template.id, language: 'en' }).update({ ...old.en });
  await db('email_template_translations').where({ template_id: template.id, language: 'de' }).update({ subject: 'Danke, {{sender_name}}!' });
  await migration.up(db);
  await migration.up(db);
  const { rows } = await translations();
  expect(rows.find((r) => r.language === 'en').body_html).not.toContain('{{sender_name}}');
  expect(rows.find((r) => r.language === 'de').subject).toBe('Danke, {{sender_name}}!');
});
