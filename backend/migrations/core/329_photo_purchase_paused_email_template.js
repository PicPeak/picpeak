'use strict';

// Confirmation for a valid payment completed during a temporary gallery pause.
// A separate template keeps customised purchase-access emails untouched.
const TRANSLATIONS = {
  en: {
    subject: 'Purchase confirmed — downloads temporarily unavailable',
    body_html: `<h2>Your purchase was successful</h2>
<p>Thank you for purchasing {{photo_count}} photos from <strong>{{gallery_name}}</strong>.</p>
<p>This gallery is temporarily unavailable. Your purchase remains valid. Please use this same link when the gallery is available again:</p>
<p><a href="{{access_link}}" class="button">View my purchase</a></p>
<p>{{access_link}}</p>
<p>Time lost during the pause will be added to your download window when the gallery returns.</p>
{{#if expiry_date}}<p>The gallery expiry remains the final cutoff: {{expiry_date}}.</p>{{/if}}
{{#if support_email}}<p>For more information, contact <a href="mailto:{{support_email}}">{{support_email}}</a>.</p>{{/if}}`,
    body_text: `Your purchase was successful

Thank you for purchasing {{photo_count}} photos from {{gallery_name}}.

This gallery is temporarily unavailable. Your purchase remains valid. Please use this same link when the gallery is available again:
{{access_link}}

Time lost during the pause will be added to your download window when the gallery returns.

{{#if expiry_date}}The gallery expiry remains the final cutoff: {{expiry_date}}.{{/if}}

{{#if support_email}}For more information, contact {{support_email}}.{{/if}}`,
  },
  de: {
    subject: 'Kauf bestätigt — Downloads vorübergehend nicht verfügbar',
    body_html: `<h2>Ihr Kauf war erfolgreich</h2>
<p>Vielen Dank für den Kauf von {{photo_count}} Fotos aus <strong>{{gallery_name}}</strong>.</p>
<p>Diese Galerie ist vorübergehend nicht verfügbar. Ihr Kauf bleibt gültig. Bitte verwenden Sie denselben Link, sobald die Galerie wieder verfügbar ist:</p>
<p><a href="{{access_link}}" class="button">Meinen Kauf ansehen</a></p>
<p>{{access_link}}</p>
<p>Die Pausenzeit wird Ihrer Zugriffsfrist gutgeschrieben, sobald die Galerie wieder verfügbar ist.</p>
{{#if expiry_date}}<p>Der Ablauf der Galerie bleibt die endgültige Grenze: {{expiry_date}}.</p>{{/if}}
{{#if support_email}}<p>Weitere Informationen erhalten Sie unter <a href="mailto:{{support_email}}">{{support_email}}</a>.</p>{{/if}}`,
    body_text: `Ihr Kauf war erfolgreich

Vielen Dank für den Kauf von {{photo_count}} Fotos aus {{gallery_name}}.

Diese Galerie ist vorübergehend nicht verfügbar. Ihr Kauf bleibt gültig. Bitte verwenden Sie denselben Link, sobald die Galerie wieder verfügbar ist:
{{access_link}}

Die Pausenzeit wird Ihrer Zugriffsfrist gutgeschrieben, sobald die Galerie wieder verfügbar ist.

{{#if expiry_date}}Der Ablauf der Galerie bleibt die endgültige Grenze: {{expiry_date}}.{{/if}}

{{#if support_email}}Weitere Informationen erhalten Sie unter {{support_email}}.{{/if}}`,
  },
};

exports.up = async function up(knex) {
  await knex.transaction(async (trx) => {
    const existing = await trx('email_templates')
      .where({ template_key: 'photo_purchase_paused' })
      .first();
    if (existing) {
      console.log('  photo_purchase_paused template already exists — skipping');
      return;
    }

    const cols = await trx('email_templates').columnInfo();
    const hasTranslationsTable = await trx.schema.hasTable('email_template_translations');

    const enContent = TRANSLATIONS.en;

    const masterRow = {
      template_key: 'photo_purchase_paused',
      variables: JSON.stringify([
        'gallery_name',
        'access_link',
        'photo_count',
        'purchased_at',
        'expires_at',
        'expiry_date',
        'support_email',
      ]),
    };
    if ('category' in cols)     masterRow.category = 'core';
    if ('subcategory' in cols)  masterRow.subcategory = 'gallery';
    if ('feature_flag' in cols) masterRow.feature_flag = null;
    if ('created_at' in cols)   masterRow.created_at = new Date();
    if ('updated_at' in cols)   masterRow.updated_at = new Date();

    // Legacy column-based fallbacks (pre-075 installs): English content in
    // every subject_*/body_* column the schema still carries.
    for (const colName of Object.keys(cols)) {
      if (colName === 'subject' || /^subject_[a-z]{2,3}$/i.test(colName)) {
        masterRow[colName] = enContent.subject;
      } else if (colName === 'body_html' || /^body_html_[a-z]{2,3}$/i.test(colName)) {
        masterRow[colName] = enContent.body_html;
      } else if (colName === 'body_text' || /^body_text_[a-z]{2,3}$/i.test(colName)) {
        masterRow[colName] = enContent.body_text;
      }
    }

    const inserted = await trx('email_templates').insert(masterRow).returning('id');
    const templateId = typeof inserted[0] === 'object' ? inserted[0].id : inserted[0];

    if (hasTranslationsTable && templateId) {
      for (const [language, content] of Object.entries(TRANSLATIONS)) {
        await trx('email_template_translations').insert({
          template_id: templateId,
          language,
          subject: content.subject,
          body_html: content.body_html,
          body_text: content.body_text,
          created_at: new Date(),
          updated_at: new Date(),
        });
      }
    }

    console.log('  photo_purchase_paused template inserted (en/de)');
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('email_templates'))) return;
  await knex('email_templates').where({ template_key: 'photo_purchase_paused' }).del();
};
