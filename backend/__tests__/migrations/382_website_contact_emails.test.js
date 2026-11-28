/**
 * Migration 382 adds the two contact-form mails of the website (issue 2618)
 * to the email templates: the studio's notification and the visitor's
 * confirmation, in English, German and Portuguese. Insert-only: a template
 * or translation that exists, edited or not, stays as it is.
 */
const { bootCrmDb } = require('../integration/helpers/crmDb');
const migration = require('../../migrations/core/382_website_contact_emails');

jest.setTimeout(120000);

let db; let cleanup;
beforeAll(async () => { ({ db, cleanup } = await bootCrmDb()); });
afterAll(async () => { if (cleanup) await cleanup(); });

test('both templates exist, in the website category behind its flag, with their languages', async () => {
  for (const key of ['website_contact_admin', 'website_contact_confirmation']) {
    const template = await db('email_templates').where({ template_key: key }).first(); // eslint-disable-line no-await-in-loop
    expect(template).toMatchObject({ category: 'website', feature_flag: 'websiteBuilder' });
    const rows = await db('email_template_translations').where({ template_id: template.id }); // eslint-disable-line no-await-in-loop
    expect(rows.map((r) => r.language).sort()).toEqual(['de', 'en', 'pt']);
  }
});

test('the confirmation never carries the message', () => {
  for (const content of Object.values(migration.TEMPLATES.website_contact_confirmation.translations)) {
    expect(`${content.subject}${content.body_html}${content.body_text}`).not.toMatch(/\{\{message\}\}/);
  }
  expect(migration.TEMPLATES.website_contact_confirmation.variables).not.toContain('message');
});

test('a second run adds a missing language and keeps an edited one', async () => {
  const template = await db('email_templates').where({ template_key: 'website_contact_admin' }).first('id');
  await db('email_template_translations').where({ template_id: template.id, language: 'pt' }).del();
  await db('email_template_translations').where({ template_id: template.id, language: 'de' }).update({ subject: 'Edited by the studio' });
  await migration.up(db);
  const rows = await db('email_template_translations').where({ template_id: template.id });
  expect(rows.map((r) => r.language).sort()).toEqual(['de', 'en', 'pt']);
  expect(rows.find((r) => r.language === 'de').subject).toBe('Edited by the studio');
});

test('down removes them', async () => {
  await migration.down(db);
  expect(await db('email_templates').whereIn('template_key', ['website_contact_admin', 'website_contact_confirmation'])).toEqual([]);
  await migration.up(db);
});
