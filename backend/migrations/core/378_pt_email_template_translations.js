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
 *   - A pt row with any content → the template is left alone (an admin
 *     wrote it).
 *   - No pt row → insert one; a pt row whose subject and both bodies are
 *     empty → fill it.
 *   - Before that, whatever English and German recipients get today is
 *     pinned down. processTemplate reads "requested language → en → any
 *     row", then the legacy subject_* / body_* columns when that row is
 *     empty. Without an English row, a new or filled pt row can become the
 *     "any row": the PicTransfer mails of migration 171 have no rows at
 *     all, and a template may hold nothing but an admin's ru or sl text.
 *     So where no English row exists, the content English is served now —
 *     from another language's row or from the legacy columns, field by
 *     field — becomes the English row, and German gets a row of its own
 *     when it was served something else (its legacy columns). Every other
 *     language without a row falls back to English and so reads the same as
 *     before.
 *
 * Idempotent: a second run finds the pt rows filled and an English row in
 * place.
 */

const { PT_EMAIL_TEMPLATES } = require('../../src/services/ptEmailTemplates');

const FIELDS = ['subject', 'body_html', 'body_text'];
const isBlank = (row) => FIELDS.every((field) => !String(row[field] || '').trim());
const sameFields = (a, b) => FIELDS.every((field) => a[field] === b[field]);
const hasContent = (fields) => Boolean(fields.subject || fields.body_html);

// What the legacy columns give a language, field by field: the German column
// for German, else the English one, else the unsuffixed column. A column the
// install does not have reads as undefined and is skipped like an empty one.
function legacyFields(template, language) {
  const fields = {};
  for (const field of FIELDS) {
    const names = [language === 'de' ? `${field}_de` : `${field}_en`, `${field}_en`, field];
    fields[field] = names.map((name) => template[name]).find(Boolean) || '';
  }
  return fields;
}

// Mirrors emailProcessor.processTemplate: what it sends for `language` as the
// rows stand. The language's own row, else the English one, else `anyRow`;
// the legacy columns when that row has no subject and no HTML.
function rendered(template, rows, anyRow, language) {
  const row = rows.find((candidate) => candidate.language === language)
    || rows.find((candidate) => candidate.language === 'en')
    || anyRow;
  if (row && hasContent(row)) {
    return { subject: row.subject || '', body_html: row.body_html || '', body_text: row.body_text || '' };
  }
  return legacyFields(template, language);
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('email_templates'))) return;
  if (!(await knex.schema.hasTable('email_template_translations'))) return;
  // ISO strings, not Date objects: they store the same way on SQLite and PG.
  const now = new Date().toISOString();
  const insert = (templateId, language, fields) => knex('email_template_translations').insert({
    template_id: templateId,
    language,
    subject: fields.subject,
    body_html: fields.body_html,
    body_text: fields.body_text,
    created_at: now,
    updated_at: now,
  });

  for (const [templateKey, pt] of Object.entries(PT_EMAIL_TEMPLATES)) {
    const template = await knex('email_templates').where({ template_key: templateKey }).first();
    if (!template) continue;
    const rows = await knex('email_template_translations').where({ template_id: template.id });
    const existing = rows.find((row) => row.language === 'pt');
    if (existing && !isBlank(existing)) continue;

    if (!rows.some((row) => row.language === 'en')) {
      // The "any row" step was this unordered query until now; asking the
      // same question keeps whatever it answered on this engine.
      const anyRow = await knex('email_template_translations').where({ template_id: template.id }).first();
      const english = rendered(template, rows, anyRow, 'en');
      const german = rendered(template, rows, anyRow, 'de');
      if (hasContent(english)) await insert(template.id, 'en', english);
      // German falls back to the English row from here on; it needs its own
      // only where it was served something else.
      const germanFollowsEnglish = hasContent(english) && sameFields(german, english);
      if (!rows.some((row) => row.language === 'de') && hasContent(german) && !germanFollowsEnglish) {
        await insert(template.id, 'de', german);
      }
    }

    if (existing) {
      await knex('email_template_translations').where({ id: existing.id }).update({
        subject: pt.subject, body_html: pt.body_html, body_text: pt.body_text, updated_at: now,
      });
    } else {
      await insert(template.id, 'pt', pt);
    }
  }
};

// Removes only pt rows that still hold the content above; an edited one stays.
// en / de rows pinned down by up() stay too: they hold what the renderer
// already sent for those languages.
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
