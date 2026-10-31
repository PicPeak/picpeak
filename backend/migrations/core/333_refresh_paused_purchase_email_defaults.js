'use strict';

// 331–332 belong to the parallel two-provider checkout work (#2280).
// Upgrade development databases that already ran the original 329. Compare
// whole default messages so studio customisations are never overwritten.
const PREVIOUS = {
  en: {
    subject: 'Purchase confirmed — downloads temporarily unavailable',
    body_html: `<h2>Your purchase was successful</h2>
<p>Thank you for purchasing {{photo_count}} photos from <strong>{{gallery_name}}</strong>.</p>
<p>This gallery is temporarily unavailable. Your purchase remains valid. Please use this same link when the gallery is available again:</p>
<p><a href="{{access_link}}" class="button">View my purchase</a></p>
<p>{{access_link}}</p>
<p>Your access deadline has not changed: {{expires_at}}.</p>
{{#if support_email}}<p>For more information, contact <a href="mailto:{{support_email}}">{{support_email}}</a>.</p>{{/if}}`,
    body_text: `Your purchase was successful

Thank you for purchasing {{photo_count}} photos from {{gallery_name}}.

This gallery is temporarily unavailable. Your purchase remains valid. Please use this same link when the gallery is available again:
{{access_link}}

Your access deadline has not changed: {{expires_at}}.

{{#if support_email}}For more information, contact {{support_email}}.{{/if}}`,
  },
  de: {
    subject: 'Kauf bestätigt — Downloads vorübergehend nicht verfügbar',
    body_html: `<h2>Dein Kauf war erfolgreich</h2>
<p>Vielen Dank für den Kauf von {{photo_count}} Fotos aus <strong>{{gallery_name}}</strong>.</p>
<p>Diese Galerie ist vorübergehend nicht verfügbar. Dein Kauf bleibt gültig. Bitte verwende denselben Link, sobald die Galerie wieder verfügbar ist:</p>
<p><a href="{{access_link}}" class="button">Meinen Kauf ansehen</a></p>
<p>{{access_link}}</p>
<p>Deine Zugriffsfrist bleibt unverändert: {{expires_at}}.</p>
{{#if support_email}}<p>Weitere Informationen erhältst du unter <a href="mailto:{{support_email}}">{{support_email}}</a>.</p>{{/if}}`,
    body_text: `Dein Kauf war erfolgreich

Vielen Dank für den Kauf von {{photo_count}} Fotos aus {{gallery_name}}.

Diese Galerie ist vorübergehend nicht verfügbar. Dein Kauf bleibt gültig. Bitte verwende denselben Link, sobald die Galerie wieder verfügbar ist:
{{access_link}}

Deine Zugriffsfrist bleibt unverändert: {{expires_at}}.

{{#if support_email}}Weitere Informationen erhältst du unter {{support_email}}.{{/if}}`,
  },
};

const CURRENT = {
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

const PREVIOUS_VARIABLES = JSON.stringify([
  'gallery_name', 'access_link', 'photo_count', 'purchased_at', 'expires_at', 'support_email',
]);
const CURRENT_VARIABLES = JSON.stringify([
  'gallery_name', 'access_link', 'photo_count', 'purchased_at', 'expires_at', 'expiry_date', 'support_email',
]);

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('email_templates'))) return;
  await knex.transaction(async (trx) => {
    const template = await trx('email_templates').where({ template_key: 'photo_purchase_paused' }).first();
    if (!template) return;
    const columns = await trx('email_templates').columnInfo();
    const previous = {}, current = {};
    // Migration 329 filled every legacy fallback column with English.
    for (const column of Object.keys(columns)) {
      const field = column === 'subject' || /^subject_[a-z]{2,3}$/i.test(column) ? 'subject'
        : column === 'body_html' || /^body_html_[a-z]{2,3}$/i.test(column) ? 'body_html'
          : column === 'body_text' || /^body_text_[a-z]{2,3}$/i.test(column) ? 'body_text' : null;
      if (field) { previous[column] = PREVIOUS.en[field]; current[column] = CURRENT.en[field]; }
    }
    if (Object.keys(previous).length) {
      await trx('email_templates').where({ id: template.id, ...previous }).update({
        ...current, ...('updated_at' in columns && { updated_at: new Date().toISOString() }),
      });
    }
    const variables = trx('email_templates').where({ id: template.id });
    if (trx.client.config.client === 'pg') variables.whereRaw('??::jsonb = ?::jsonb', ['variables', PREVIOUS_VARIABLES]);
    else variables.where({ variables: PREVIOUS_VARIABLES });
    await variables.update({ variables: CURRENT_VARIABLES });
    if (await trx.schema.hasTable('email_template_translations')) {
      for (const language of Object.keys(PREVIOUS)) {
        await trx('email_template_translations')
          .where({ template_id: template.id, language, ...PREVIOUS[language] })
          .update({ ...CURRENT[language], updated_at: new Date().toISOString() });
      }
    }
  });
};

// Do not restore incorrect deadline copy or overwrite later studio edits.
exports.down = async function down() {};
