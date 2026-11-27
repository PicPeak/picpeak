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
 *   - A template still kept only in the legacy subject_en / body_*_en /
 *     *_de columns, with no translation rows at all (the PicTransfer mails
 *     of migration 171), first gets en / de rows copied from those columns.
 *     processTemplate falls back to "any available language" when neither
 *     the requested language nor en has a row, so a lone pt row would
 *     otherwise go to English and German recipients too. The copy is
 *     verbatim, so those mails read exactly as before.
 *
 * Idempotent: a second run finds every pt row filled and every legacy
 * template already materialised.
 */

const { PT_EMAIL_TEMPLATES } = require('../../src/services/ptEmailTemplates');

const FIELDS = ['subject', 'body_html', 'body_text'];
const isBlank = (row) => FIELDS.every((field) => !String(row[field] || '').trim());

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('email_templates'))) return;
  if (!(await knex.schema.hasTable('email_template_translations'))) return;
  const cols = await knex('email_templates').columnInfo();
  // ISO strings, not Date objects: they store the same way on SQLite and PG.
  const now = new Date().toISOString();

  for (const [templateKey, pt] of Object.entries(PT_EMAIL_TEMPLATES)) {
    const template = await knex('email_templates').where({ template_key: templateKey }).first();
    if (!template) continue;
    const rows = await knex('email_template_translations').where({ template_id: template.id });

    if (rows.length === 0) {
      for (const language of ['en', 'de']) {
        const legacy = {};
        for (const field of FIELDS) {
          // English may sit in the unsuffixed column on older installs.
          const names = language === 'en' ? [`${field}_en`, field] : [`${field}_${language}`];
          legacy[field] = names.map((name) => (name in cols ? template[name] : '')).find(Boolean) || '';
        }
        if (isBlank(legacy)) continue;
        await knex('email_template_translations').insert({
          template_id: template.id, language, ...legacy, created_at: now, updated_at: now,
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
// en / de rows copied from the legacy columns stay too: they repeat those
// columns verbatim and the mails read the same with or without them.
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
