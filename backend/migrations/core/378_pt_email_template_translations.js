/**
 * Migration: Brazilian Portuguese (pt) content for the email templates that
 * had none (issue 2617).
 *
 * The CRM quote / invoice / contract / booking / customer-document mails,
 * event reminders, gallery delivery and lifecycle, photo sales and
 * PicTransfer mails only had en / de rows, so a pt recipient got the English
 * mail. The content lives in src/services/ptEmailTemplates.js, which
 * the boot seeders also insert with every template they create; this
 * migration covers templates that already exist on an upgraded install.
 *
 * Per template present in the database:
 *   - No pt row → insert one.
 *   - A pt row whose subject and both bodies are empty → fill it.
 *   - A pt row with any content → left alone (an admin wrote it).
 *   - First, en and de are materialised wherever processTemplate would
 *     still read them from the legacy subject_* / body_* columns (the
 *     PicTransfer mails of migration 171 have no translation rows at all).
 *     Its row choice is "requested language → en → any row", so a new or
 *     filled pt row would otherwise become the "any row" English and
 *     German recipients get. Each language is decided on the rows as they
 *     were, and gets exactly the fields the renderer picked from the legacy
 *     columns (German falls back to English field by field), so those mails
 *     read the same as before.
 *
 * Idempotent: a second run finds every pt row filled and every legacy
 * language already materialised.
 */

const { PT_EMAIL_TEMPLATES } = require('../../src/services/ptEmailTemplates');

const FIELDS = ['subject', 'body_html', 'body_text'];
const isBlank = (row) => FIELDS.every((field) => !String(row[field] || '').trim());

// Mirrors emailProcessor.processTemplate. The row it reads for a language:
// that language's own row, else the English one, else any row (first by id).
const chosenRow = (rows, language) => rows.find((row) => row.language === language)
  || rows.find((row) => row.language === 'en')
  || rows[0];
// It falls back to the legacy columns when that row has no subject and no HTML.
const readsLegacy = (row) => !row || (!row.subject && !row.body_html);
// What it then sends, field by field: the German column for German, else the
// English one, else the unsuffixed column. A column the install does not have
// reads as undefined and is skipped like an empty one.
function legacyFields(template, language) {
  const fields = {};
  for (const field of FIELDS) {
    const names = [language === 'de' ? `${field}_de` : `${field}_en`, `${field}_en`, field];
    fields[field] = names.map((name) => template[name]).find(Boolean) || '';
  }
  return fields;
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('email_templates'))) return;
  if (!(await knex.schema.hasTable('email_template_translations'))) return;
  // ISO strings, not Date objects: they store the same way on SQLite and PG.
  const now = new Date().toISOString();

  for (const [templateKey, pt] of Object.entries(PT_EMAIL_TEMPLATES)) {
    const template = await knex('email_templates').where({ template_key: templateKey }).first();
    if (!template) continue;
    const rows = await knex('email_template_translations').where({ template_id: template.id }).orderBy('id');

    const materialise = ['en', 'de']
      .filter((language) => readsLegacy(chosenRow(rows, language)))
      .map((language) => ({ language, fields: legacyFields(template, language) }))
      .filter(({ fields }) => fields.subject || fields.body_html);
    for (const { language, fields } of materialise) {
      const own = rows.find((row) => row.language === language);
      if (own) {
        await knex('email_template_translations').where({ id: own.id }).update({ ...fields, updated_at: now });
      } else {
        await knex('email_template_translations').insert({
          template_id: template.id, language, ...fields, created_at: now, updated_at: now,
        });
      }
    }

    const existing = rows.find((row) => row.language === 'pt');
    if (!existing) {
      await knex('email_template_translations').insert({
        template_id: template.id,
        language: 'pt',
        subject: pt.subject,
        body_html: pt.body_html,
        body_text: pt.body_text,
        created_at: now,
        updated_at: now,
      });
    } else if (isBlank(existing)) {
      await knex('email_template_translations').where({ id: existing.id }).update({
        subject: pt.subject, body_html: pt.body_html, body_text: pt.body_text, updated_at: now,
      });
    }
  }
};

// Removes only pt rows that still hold the content above; an edited one stays.
// en / de rows materialised from the legacy columns stay too: they hold what
// the renderer already sent from those columns, so the mails read the same
// with or without them.
exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('email_templates'))) return;
  if (!(await knex.schema.hasTable('email_template_translations'))) return;
  for (const [templateKey, pt] of Object.entries(PT_EMAIL_TEMPLATES)) {
    const template = await knex('email_templates').where({ template_key: templateKey }).first();
    if (!template) continue;
    await knex('email_template_translations')
      .where({ template_id: template.id, language: 'pt', subject: pt.subject, body_html: pt.body_html, body_text: pt.body_text })
      .del();
  }
};
