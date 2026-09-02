/**
 * Migration 195: finish the job migration 194 started for the remaining three
 * customer-facing gallery-lifecycle mails — `expiration_warning`,
 * `gallery_expired` and `archive_complete`.
 *
 * Investigating them turned up TWO different fresh-install defects, not one:
 *
 *   1. `expiration_warning` is the exact defect 194 fixed for
 *      `gallery_created`: migration 001 seeds it, 059 copies `_en` into `_de`
 *      ("Copy to German as default"), 075 materialises those columns as the
 *      `de` translation row, and the real German only ever existed in the
 *      LEGACY migrations (026), which never run on a fresh install. Every
 *      install created since then mails English to German-locale recipients
 *      while nl/pt/ru/fr/es/sl are all localised.
 *
 *   2. `gallery_expired` and `archive_complete` are NOT German-is-English on a
 *      fresh install — they are ABSENT. Their master rows are only ever
 *      inserted by legacy migrations 010/020; no core migration seeds them.
 *      Verified by running the core migration set against an empty database:
 *      the resulting `email_templates` holds 17 keys and neither of these two
 *      is among them. So `expirationChecker.sendGalleryExpiredEmails` and
 *      `archiveService`'s completion mail both hit
 *      `Email template '<key>' not found` in emailProcessor (line 759) on
 *      every fresh install — the queue row then retries three times and dies
 *      silently. 075/099/106/108 seeded no translations for them either,
 *      because they key off a master row that does not exist.
 *
 * This migration therefore does two things, both conservative:
 *
 *   - REPAIR: rewrite a German field (and the legacy `_de` columns) only
 *     while it is still byte-identical to the English one, or empty. That is
 *     precisely the broken state. Each of subject / body_html / body_text is
 *     judged on its own, so a legacy install whose German came from migration
 *     026, or any install where an admin edited even one field, keeps what it
 *     has.
 *   - SEED: insert `gallery_expired` / `archive_complete` with EN + DE only
 *     when the master row is missing entirely. Never overwrites an existing
 *     row.
 *
 * The German copy follows legacy migration 026's wording — the translation
 * that was always intended — restructured to mirror the English it sits next
 * to, so the placeholder set of each German body matches its English original
 * exactly. The seeded English follows legacy 028 (which emailProcessor's own
 * comments treat as the shipped copy) but in the plain, unstyled shape the
 * other core-seeded templates use, so `wrapEmailHtml`'s configurable email
 * palette governs the styling instead of hard-coded hex values.
 *
 * Known gap, deliberately not closed here: the two seeded templates get en/de
 * only. nl/pt/ru/fr/es/sl fall back to `en` via processTemplate's fallback
 * chain, which is strictly better than today's hard failure.
 */

// ── expiration_warning ────────────────────────────────────────────────
// Placeholders mirror the English original seeded by migration 001:
// host_name, event_name, days_remaining, gallery_link.

const WARNING_SUBJECT_DE = 'Ihre Fotogalerie läuft bald ab';

const WARNING_HTML_DE = `<h2>Galerie läuft bald ab</h2>
<p>Guten Tag {{host_name}},</p>
<p>Ihre Fotogalerie „{{event_name}}“ läuft in {{days_remaining}} Tagen ab.</p>
<p>Nach Ablauf wird die Galerie archiviert und ist für Gäste nicht mehr zugänglich.</p>
<p><a href="{{gallery_link}}">Galerie ansehen</a></p>`;

const WARNING_TEXT_DE = 'Galerie läuft bald ab\n\nGuten Tag {{host_name}},\n\nIhre Fotogalerie „{{event_name}}“ läuft in {{days_remaining}} Tagen ab.';

// ── gallery_expired ───────────────────────────────────────────────────
// Variables filled by expirationChecker.sendGalleryExpiredEmails.
// {{support_email}} is wrapped in a conditional because getSupportEmail()
// returns '' when neither branding_support_email nor an SMTP from-address
// is configured (see emailProcessor.js:110).

const EXPIRED_VARIABLES = ['host_name', 'event_name', 'event_date', 'expiry_date', 'support_email'];

const EXPIRED_EN = {
  subject: 'Your Photo Gallery Has Expired',
  body_html: `<h2>Gallery Expired</h2>
<p>Dear {{host_name}},</p>
<p>Your photo gallery "{{event_name}}" expired on {{expiry_date}} and is no longer accessible online.</p>
<p>Your photos have been archived safely — nothing is lost.</p>
<p><strong>Gallery Details:</strong></p>
<ul>
  <li>Event Date: {{event_date}}</li>
  <li>Expired: {{expiry_date}}</li>
</ul>
{{#if support_email}}<p>If you need access to the archived photos, contact us at <a href="mailto:{{support_email}}">{{support_email}}</a>.</p>{{/if}}`,
  body_text: 'Gallery Expired\n\nDear {{host_name}},\n\nYour photo gallery "{{event_name}}" expired on {{expiry_date}} and is no longer accessible online.\n\nYour photos have been archived safely — nothing is lost.\n\nEvent Date: {{event_date}}\nExpired: {{expiry_date}}\n\n{{#if support_email}}If you need access to the archived photos, contact us at {{support_email}}.{{/if}}',
};

const EXPIRED_DE = {
  subject: 'Ihre Fotogalerie ist abgelaufen',
  body_html: `<h2>Galerie abgelaufen</h2>
<p>Guten Tag {{host_name}},</p>
<p>Ihre Fotogalerie „{{event_name}}“ ist am {{expiry_date}} abgelaufen und online nicht mehr zugänglich.</p>
<p>Ihre Fotos wurden sicher archiviert — es geht nichts verloren.</p>
<p><strong>Details zur Galerie:</strong></p>
<ul>
  <li>Veranstaltungsdatum: {{event_date}}</li>
  <li>Abgelaufen am: {{expiry_date}}</li>
</ul>
{{#if support_email}}<p>Wenn Sie Zugriff auf die archivierten Fotos benötigen, wenden Sie sich an <a href="mailto:{{support_email}}">{{support_email}}</a>.</p>{{/if}}`,
  body_text: 'Galerie abgelaufen\n\nGuten Tag {{host_name}},\n\nIhre Fotogalerie „{{event_name}}“ ist am {{expiry_date}} abgelaufen und online nicht mehr zugänglich.\n\nIhre Fotos wurden sicher archiviert — es geht nichts verloren.\n\nVeranstaltungsdatum: {{event_date}}\nAbgelaufen am: {{expiry_date}}\n\n{{#if support_email}}Wenn Sie Zugriff auf die archivierten Fotos benötigen, wenden Sie sich an {{support_email}}.{{/if}}',
};

// ── archive_complete ──────────────────────────────────────────────────
// Variables filled by archiveService. This one goes to the admin address.

const ARCHIVE_VARIABLES = ['host_name', 'event_name', 'event_date', 'archive_date', 'photo_count', 'archive_size', 'support_email'];

const ARCHIVE_EN = {
  subject: 'Archive Complete: {{event_name}}',
  body_html: `<h2>Archive Complete</h2>
<p>Dear {{host_name}},</p>
<p>The photo gallery "{{event_name}}" has been archived successfully.</p>
<p><strong>Archive Details:</strong></p>
<ul>
  <li>Event Date: {{event_date}}</li>
  <li>Archived: {{archive_date}}</li>
  <li>Number of Photos: {{photo_count}}</li>
  <li>Archive Size: {{archive_size}}</li>
</ul>
<p>The archive is stored securely and can be restored if needed.</p>
{{#if support_email}}<p>Questions? Contact us at <a href="mailto:{{support_email}}">{{support_email}}</a>.</p>{{/if}}`,
  body_text: 'Archive Complete\n\nDear {{host_name}},\n\nThe photo gallery "{{event_name}}" has been archived successfully.\n\nEvent Date: {{event_date}}\nArchived: {{archive_date}}\nNumber of Photos: {{photo_count}}\nArchive Size: {{archive_size}}\n\nThe archive is stored securely and can be restored if needed.\n\n{{#if support_email}}Questions? Contact us at {{support_email}}.{{/if}}',
};

const ARCHIVE_DE = {
  subject: 'Archivierung abgeschlossen: {{event_name}}',
  body_html: `<h2>Archivierung abgeschlossen</h2>
<p>Guten Tag {{host_name}},</p>
<p>Die Fotogalerie „{{event_name}}“ wurde erfolgreich archiviert.</p>
<p><strong>Details zum Archiv:</strong></p>
<ul>
  <li>Veranstaltungsdatum: {{event_date}}</li>
  <li>Archiviert am: {{archive_date}}</li>
  <li>Anzahl der Fotos: {{photo_count}}</li>
  <li>Archivgröße: {{archive_size}}</li>
</ul>
<p>Das Archiv wird sicher aufbewahrt und kann bei Bedarf wiederhergestellt werden.</p>
{{#if support_email}}<p>Fragen? Wenden Sie sich an <a href="mailto:{{support_email}}">{{support_email}}</a>.</p>{{/if}}`,
  body_text: 'Archivierung abgeschlossen\n\nGuten Tag {{host_name}},\n\nDie Fotogalerie „{{event_name}}“ wurde erfolgreich archiviert.\n\nVeranstaltungsdatum: {{event_date}}\nArchiviert am: {{archive_date}}\nAnzahl der Fotos: {{photo_count}}\nArchivgröße: {{archive_size}}\n\nDas Archiv wird sicher aufbewahrt und kann bei Bedarf wiederhergestellt werden.\n\n{{#if support_email}}Fragen? Wenden Sie sich an {{support_email}}.{{/if}}',
};

// "Not translated yet" = empty, or still the English text.
const isUntranslated = (german, english) => {
  const de = (german || '').trim();
  if (!de) return true;
  return de === (english || '').trim();
};

/**
 * Rewrite the German translation row + legacy `_de` columns of an existing
 * template, but only while they are still the English copy (or empty).
 */
async function repairGerman(knex, templateKey, german, now) {
  const master = await knex('email_templates').where('template_key', templateKey).first();
  if (!master) return false;

  if (await knex.schema.hasTable('email_template_translations')) {
    const enRow = await knex('email_template_translations')
      .where({ template_id: master.id, language: 'en' })
      .first();
    const deRow = await knex('email_template_translations')
      .where({ template_id: master.id, language: 'de' })
      .first();

    const englishSubject = (enRow && enRow.subject) || master.subject_en || master.subject || '';
    const englishHtml = (enRow && enRow.body_html) || master.body_html_en || master.body_html || '';
    const englishText = (enRow && enRow.body_text) || master.body_text_en || master.body_text || '';

    if (!deRow) {
      await knex('email_template_translations').insert({
        template_id: master.id,
        language: 'de',
        subject: german.subject,
        body_html: german.body_html,
        body_text: german.body_text,
        created_at: now,
        updated_at: now,
      });
    } else {
      // Each field is judged on its own, as in migration 194. Gating all three
      // on body_html would overwrite a subject the admin had already translated
      // whenever the HTML still matched English — and down() is a deliberate
      // no-op, so that loss would be unrecoverable.
      const patch = {};
      if (isUntranslated(deRow.subject, englishSubject)) patch.subject = german.subject;
      if (isUntranslated(deRow.body_html, englishHtml)) patch.body_html = german.body_html;
      if (isUntranslated(deRow.body_text, englishText)) patch.body_text = german.body_text;
      if (Object.keys(patch).length > 0) {
        patch.updated_at = now;
        await knex('email_template_translations').where({ id: deRow.id }).update(patch);
      }
    }
  }

  // Legacy per-language columns on the master row — still the fallback path in
  // emailProcessor.processTemplate when the translations table is unavailable.
  const cols = await knex('email_templates').columnInfo();
  if (cols.body_html_de) {
    // Same per-field rule as the translations table above.
    const legacyPatch = {};
    if (cols.subject_de && isUntranslated(master.subject_de, master.subject_en)) {
      legacyPatch.subject_de = german.subject;
    }
    if (isUntranslated(master.body_html_de, master.body_html_en)) {
      legacyPatch.body_html_de = german.body_html;
    }
    if (cols.body_text_de && isUntranslated(master.body_text_de, master.body_text_en)) {
      legacyPatch.body_text_de = german.body_text;
    }
    if (Object.keys(legacyPatch).length > 0) {
      legacyPatch.updated_at = now;
      await knex('email_templates').where({ id: master.id }).update(legacyPatch);
    }
  }
  return true;
}

/**
 * Insert a master row + en/de translations for a template that is missing
 * entirely. No-op when the row already exists — this never overwrites.
 */
async function seedTemplate(knex, templateKey, { en, de, variables }, now) {
  const existing = await knex('email_templates').where('template_key', templateKey).first();
  if (existing) return false;

  const cols = await knex('email_templates').columnInfo();
  const masterRow = { template_key: templateKey, variables: JSON.stringify(variables) };
  if ('category' in cols) masterRow.category = 'core';
  if ('subcategory' in cols) masterRow.subcategory = 'gallery';
  if ('feature_flag' in cols) masterRow.feature_flag = null;
  if ('created_at' in cols) masterRow.created_at = now;
  if ('updated_at' in cols) masterRow.updated_at = now;

  // Fill whichever of the legacy subject_*/body_html_*/body_text_* columns the
  // schema still carries: German into `_de`, English everywhere else.
  for (const colName of Object.keys(cols)) {
    const source = /_de$/.test(colName) ? de : en;
    if (colName === 'subject' || /^subject_[a-z]{2,3}$/i.test(colName)) {
      masterRow[colName] = source.subject;
    } else if (colName === 'body_html' || /^body_html_[a-z]{2,3}$/i.test(colName)) {
      masterRow[colName] = source.body_html;
    } else if (colName === 'body_text' || /^body_text_[a-z]{2,3}$/i.test(colName)) {
      masterRow[colName] = source.body_text;
    }
  }

  const inserted = await knex('email_templates').insert(masterRow).returning('id');
  const templateId = typeof inserted[0] === 'object' ? inserted[0].id : inserted[0];

  if (templateId && await knex.schema.hasTable('email_template_translations')) {
    for (const [language, content] of [['en', en], ['de', de]]) {
      await knex('email_template_translations').insert({
        template_id: templateId,
        language,
        subject: content.subject,
        body_html: content.body_html,
        body_text: content.body_text,
        created_at: now,
        updated_at: now,
      });
    }
  }
  return true;
}

exports.up = async function(knex) {
  if (!(await knex.schema.hasTable('email_templates'))) return;

  const now = new Date().toISOString();

  await repairGerman(knex, 'expiration_warning', {
    subject: WARNING_SUBJECT_DE,
    body_html: WARNING_HTML_DE,
    body_text: WARNING_TEXT_DE,
  }, now);

  for (const [key, content] of [
    ['gallery_expired', { en: EXPIRED_EN, de: EXPIRED_DE, variables: EXPIRED_VARIABLES }],
    ['archive_complete', { en: ARCHIVE_EN, de: ARCHIVE_DE, variables: ARCHIVE_VARIABLES }],
  ]) {
    const seeded = await seedTemplate(knex, key, content, now);
    if (!seeded) {
      // Row already there (a legacy install). Repair its German the same
      // conservative way — a no-op wherever legacy 026 already translated it.
      await repairGerman(knex, key, content.de, now);
    }
  }
};

exports.down = async function() {
  // No-op: reverting would restore English-as-German and delete templates the
  // expiry/archive mail paths depend on. Admins who want different copy can
  // edit it under Settings → Email → Templates.
};
