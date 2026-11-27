'use strict';

const { PT_EMAIL_TEMPLATES } = require('./ptEmailTemplates');

/**
 * Bring a seeded email template up to date when its default text changed.
 *
 * A stored template still identical to its previous default (`previousDefaults`,
 * keyed like `templates`, en + de) gets the current default; one an admin has
 * edited is left as it is. In email_template_translations a language is
 * matched on subject + both bodies together, so one edited field keeps that
 * whole language as it is; the legacy per-language columns on email_templates
 * are compared and upgraded field by field. Used by the seeders whose
 * defaults changed after they shipped (crmEmailTemplates, galleryDeliveryTemplates).
 */
async function upgradeUneditedTemplates(db, { templates, previousDefaults, cols, hasTranslationsTable, logger }) {
  for (const [templateKey, previous] of Object.entries(previousDefaults)) {
    const def = templates[templateKey];
    const row = await db('email_templates').where({ template_key: templateKey }).first();
    if (!row) continue;
    let upgraded = false;
    if (hasTranslationsTable) {
      for (const lang of ['en', 'de']) {
        const old = previous[lang];
        const next = def[lang];
        if (!old || !next) continue;
        const updated = await db('email_template_translations')
          .where({ template_id: row.id, language: lang, subject: old.subject, body_html: old.body_html, body_text: old.body_text })
          .update({ subject: next.subject, body_html: next.body_html, body_text: next.body_text, updated_at: new Date().toISOString() });
        if (updated) upgraded = true;
      }
    }
    const legacy = {};
    for (const field of ['subject', 'body_html', 'body_text']) {
      for (const colName of Object.keys(cols)) {
        if ((colName === field || colName === `${field}_en`) && row[colName] === previous.en[field]) legacy[colName] = def.en[field];
        if (colName === `${field}_de` && previous.de && row[colName] === previous.de[field]) legacy[colName] = def.de[field];
      }
    }
    if (Object.keys(legacy).length) {
      await db('email_templates').where({ id: row.id }).update(legacy);
      upgraded = true;
    }
    if (upgraded) {
      await db('email_templates').where({ id: row.id }).update({ variables: JSON.stringify(def.variables) });
      if (logger) logger.info(`Updated the unedited default email template: ${templateKey}`);
    }
  }
}

/**
 * Insert any missing templates of `templates` (keyed by template_key, with
 * en + de content) into email_templates + email_template_translations. Fills
 * whichever legacy subject_<lang> / body_html_<lang> / body_text_<lang>
 * columns the install has with the English text. Stops at the first failed
 * insert without throwing: the caller keeps its "seeded" flag unset so the
 * next call retries, and queueEmail surfaces its own error if the template
 * still can't be looked up. `label` names the set in the log lines.
 *
 * Returns null without an email_templates table, else
 * `{ inserted, failed, cols, hasTranslationsTable }`.
 */
async function seedTemplates(db, logger, templates, label) {
  if (!(await db.schema.hasTable('email_templates'))) return null;
  const cols = await db('email_templates').columnInfo();
  const hasTranslationsTable = await db.schema.hasTable('email_template_translations');
  const inserted = [];

  for (const [templateKey, def] of Object.entries(templates)) {
    const existing = await db('email_templates').where({ template_key: templateKey }).first();
    if (existing) continue;

    const enContent = def.en;
    const masterRow = {
      template_key: templateKey,
      variables: JSON.stringify(def.variables),
    };
    if ('category' in cols)     masterRow.category = def.category;
    if ('subcategory' in cols)  masterRow.subcategory = null;
    if ('feature_flag' in cols) masterRow.feature_flag = def.feature_flag;
    if ('created_at' in cols)   masterRow.created_at = new Date();
    if ('updated_at' in cols)   masterRow.updated_at = new Date();
    for (const colName of Object.keys(cols)) {
      if (colName === 'subject' || /^subject_[a-z]{2,3}$/i.test(colName)) {
        masterRow[colName] = enContent.subject;
      } else if (colName === 'body_html' || /^body_html_[a-z]{2,3}$/i.test(colName)) {
        masterRow[colName] = enContent.body_html;
      } else if (colName === 'body_text' || /^body_text_[a-z]{2,3}$/i.test(colName)) {
        masterRow[colName] = enContent.body_text;
      }
    }

    try {
      const rows = await db('email_templates').insert(masterRow).returning('id');
      const templateId = typeof rows[0] === 'object' ? rows[0].id : rows[0];
      if (hasTranslationsTable && templateId) {
        for (const lang of ['en', 'de', 'pt']) {
          const content = lang === 'pt' ? PT_EMAIL_TEMPLATES[templateKey] : def[lang];
          if (!content) continue;
          await db('email_template_translations').insert({
            template_id: templateId,
            language: lang,
            subject: content.subject,
            body_html: content.body_html,
            body_text: content.body_text,
            created_at: new Date(),
            updated_at: new Date(),
          });
        }
      }
      inserted.push(templateKey);
      if (logger) {
        logger.info(`Self-healed missing ${label} email template at runtime: ${templateKey}`);
      }
    } catch (err) {
      if (logger) {
        logger.error(`Failed to seed ${label} email template ${templateKey}`, {
          message: err.message,
        });
      }
      return { inserted, failed: true, cols, hasTranslationsTable };
    }
  }
  return { inserted, failed: false, cols, hasTranslationsTable };
}

module.exports = { upgradeUneditedTemplates, seedTemplates };
