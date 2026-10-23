'use strict';

/**
 * Migration 318: the `photo_purchase_access` email template (photo sales).
 *
 * Sent after a Snipcart order.completed webhook created the purchase rows,
 * and re-sent by the admin from the gallery's Orders tab. Carries the
 * access link to /purchased-downloads/:accessToken — the token is bound to
 * the order and the actual entitlement check runs against
 * photo_purchases.expires_at.
 *
 * Variables:
 *   - gallery_name   name (or slug) of the gallery the photos were bought from
 *   - access_link    full URL of /purchased-downloads/:accessToken
 *   - photo_count    number of photos in this order
 *   - purchased_at   ISO purchase timestamp (date-formatted by the mailer)
 *   - expires_at     ISO expiry timestamp (date-formatted by the mailer)
 *   - support_email  optional global support contact
 *
 * Idempotent: skips if the template_key already exists. en + de hand-written;
 * every other locale falls back to the English copy, the same chain the
 * mailer uses for templates without a native translation.
 */

const TRANSLATIONS = {
  en: {
    subject: 'Your photo downloads are ready',
    body_html: `<h2>Your photos are ready to download</h2>
<p>Thank you for your purchase!</p>
<p>The photos you bought from <strong>{{gallery_name}}</strong> are ready. You can download them in full quality — without watermark — from your personal access page:</p>
<p style="text-align: center; margin: 30px 0;">
  <a href="{{access_link}}" class="button">Download my photos</a>
</p>
<p style="font-size: 13px; color: #666;">If the button doesn't work, copy and paste this link into your browser:<br>
<span style="word-break: break-all;">{{access_link}}</span></p>
<ul>
  <li>Photos: {{photo_count}}</li>
  <li>Purchased: {{purchased_at}}</li>
  <li>Access expires: {{expires_at}}</li>
</ul>
<p style="font-size: 13px; color: #666;">You can download your photos as often as you like until the access expires.</p>
{{#if support_email}}<p>Questions? Contact us at <a href="mailto:{{support_email}}">{{support_email}}</a>.</p>{{/if}}`,
    body_text: `Your photos are ready to download

Thank you for your purchase!

The photos you bought from {{gallery_name}} are ready. Download them in full quality — without watermark — from your personal access page:

{{access_link}}

Photos: {{photo_count}}
Purchased: {{purchased_at}}
Access expires: {{expires_at}}

You can download your photos as often as you like until the access expires.

{{#if support_email}}Questions? Contact us at {{support_email}}.{{/if}}`,
  },
  de: {
    subject: 'Deine Fotos stehen zum Download bereit',
    body_html: `<h2>Deine Fotos stehen zum Download bereit</h2>
<p>Vielen Dank für deinen Kauf!</p>
<p>Die Fotos, die du aus <strong>{{gallery_name}}</strong> gekauft hast, stehen bereit. Du kannst sie in voller Qualität — ohne Wasserzeichen — über deine persönliche Zugriffsseite herunterladen:</p>
<p style="text-align: center; margin: 30px 0;">
  <a href="{{access_link}}" class="button">Fotos herunterladen</a>
</p>
<p style="font-size: 13px; color: #666;">Falls der Button nicht funktioniert, kopiere diesen Link in deinen Browser:<br>
<span style="word-break: break-all;">{{access_link}}</span></p>
<ul>
  <li>Fotos: {{photo_count}}</li>
  <li>Gekauft am: {{purchased_at}}</li>
  <li>Zugriff gültig bis: {{expires_at}}</li>
</ul>
<p style="font-size: 13px; color: #666;">Du kannst deine Fotos bis zum Ablauf der Zugriffsdauer beliebig oft herunterladen.</p>
{{#if support_email}}<p>Fragen? Wende dich an <a href="mailto:{{support_email}}">{{support_email}}</a>.</p>{{/if}}`,
    body_text: `Deine Fotos stehen zum Download bereit

Vielen Dank für deinen Kauf!

Die Fotos, die du aus {{gallery_name}} gekauft hast, stehen bereit. Lade sie in voller Qualität — ohne Wasserzeichen — über deine persönliche Zugriffsseite herunter:

{{access_link}}

Fotos: {{photo_count}}
Gekauft am: {{purchased_at}}
Zugriff gültig bis: {{expires_at}}

Du kannst deine Fotos bis zum Ablauf der Zugriffsdauer beliebig oft herunterladen.

{{#if support_email}}Fragen? Wende dich an {{support_email}}.{{/if}}`,
  },
};

exports.up = async function up(knex) {
  const existing = await knex('email_templates')
    .where({ template_key: 'photo_purchase_access' })
    .first();
  if (existing) {
    console.log('  photo_purchase_access template already exists — skipping');
    return;
  }

  const cols = await knex('email_templates').columnInfo();
  const hasTranslationsTable = await knex.schema.hasTable('email_template_translations');

  const enContent = TRANSLATIONS.en;

  const masterRow = {
    template_key: 'photo_purchase_access',
    variables: JSON.stringify([
      'gallery_name',
      'access_link',
      'photo_count',
      'purchased_at',
      'expires_at',
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

  const inserted = await knex('email_templates').insert(masterRow).returning('id');
  const templateId = typeof inserted[0] === 'object' ? inserted[0].id : inserted[0];

  if (hasTranslationsTable && templateId) {
    for (const [language, content] of Object.entries(TRANSLATIONS)) {
      await knex('email_template_translations').insert({
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

  console.log('  photo_purchase_access template inserted (en/de)');
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('email_templates'))) return;
  await knex('email_templates').where({ template_key: 'photo_purchase_access' }).del();
};
