/**
 * Migration 194: give `gallery_created` a real German translation.
 *
 * On a fresh install the German copy of this template is the ENGLISH copy,
 * verbatim. Migration 059 introduces the multilingual columns by seeding
 * `subject_de`/`body_html_de`/`body_text_de` from their `_en` counterparts
 * ("Copy to German as default"), and migration 075 then materialises exactly
 * those columns as the `de` row in `email_template_translations`. The proper
 * German lived only in the LEGACY migrations (009/026), which never run on a
 * fresh install — so every install created since then mails English to
 * German-locale recipients, while nl/pt/ru/fr/es/sl are all localised.
 *
 * This is the most customer-visible transactional mail we send (one per
 * published gallery), so it is repaired as a content UPDATE: a code-only fix
 * would leave every existing install on the English-as-German row forever,
 * because Knex will not re-run 059/075.
 *
 * Idempotent, and deliberately conservative about WHICH rows it touches: the
 * German row is rewritten only while it is still byte-identical to the English
 * one (or empty), which is precisely the broken state. A legacy install whose
 * German came from migration 026, or any install where an admin has edited the
 * template themselves, is left alone.
 *
 * The placeholder set matches the English original exactly — host_name,
 * event_name, event_date, gallery_link, gallery_password, expiry_date — which
 * is also the template's declared `variables` array.
 */

const SUBJECT_DE = 'Ihre Fotogalerie ist bereit!';

const HTML_DE = `<h2>Galerie erfolgreich erstellt</h2>
<p>Guten Tag {{host_name}},</p>
<p>Ihre Fotogalerie „{{event_name}}“ wurde erfolgreich erstellt!</p>
<p><strong>Details zur Galerie:</strong></p>
<ul>
  <li>Veranstaltungsdatum: {{event_date}}</li>
  <li>Link zur Galerie: <a href="{{gallery_link}}">{{gallery_link}}</a></li>
  <li>Passwort: {{gallery_password}}</li>
  <li>Verfügbar bis: {{expiry_date}}</li>
</ul>
<p>Teilen Sie diesen Link und das Passwort mit Ihren Gästen, damit diese die Fotos ansehen und herunterladen können.</p>`;

const TEXT_DE = 'Galerie erfolgreich erstellt\n\nGuten Tag {{host_name}},\n\nIhre Fotogalerie „{{event_name}}“ wurde erfolgreich erstellt!\n\nVeranstaltungsdatum: {{event_date}}\nLink zur Galerie: {{gallery_link}}\nPasswort: {{gallery_password}}\nVerfügbar bis: {{expiry_date}}\n\nTeilen Sie diesen Link und das Passwort mit Ihren Gästen, damit diese die Fotos ansehen und herunterladen können.';

// "Not translated yet" = empty, or still the English text.
const isUntranslated = (german, english) => {
  const de = (german || '').trim();
  if (!de) return true;
  return de === (english || '').trim();
};

exports.up = async function(knex) {
  if (!(await knex.schema.hasTable('email_templates'))) return;

  const master = await knex('email_templates')
    .where('template_key', 'gallery_created')
    .first();
  if (!master) return; // Template not seeded on this install — nothing to fix.

  const now = new Date().toISOString();

  if (await knex.schema.hasTable('email_template_translations')) {
    const enRow = await knex('email_template_translations')
      .where({ template_id: master.id, language: 'en' })
      .first();
    const deRow = await knex('email_template_translations')
      .where({ template_id: master.id, language: 'de' })
      .first();

    const englishHtml = (enRow && enRow.body_html) || master.body_html_en || master.body_html || '';

    if (!deRow) {
      await knex('email_template_translations').insert({
        template_id: master.id,
        language: 'de',
        subject: SUBJECT_DE,
        body_html: HTML_DE,
        body_text: TEXT_DE,
        created_at: now,
        updated_at: now,
      });
    } else if (isUntranslated(deRow.body_html, englishHtml)) {
      await knex('email_template_translations')
        .where({ id: deRow.id })
        .update({
          subject: SUBJECT_DE,
          body_html: HTML_DE,
          body_text: TEXT_DE,
          updated_at: now,
        });
    }
  }

  // Legacy per-language columns on the master row — still the fallback path in
  // emailProcessor.processTemplate when the translations table is unavailable.
  const cols = await knex('email_templates').columnInfo();
  if (cols.body_html_de && isUntranslated(master.body_html_de, master.body_html_en)) {
    await knex('email_templates')
      .where({ id: master.id })
      .update({
        subject_de: SUBJECT_DE,
        body_html_de: HTML_DE,
        body_text_de: TEXT_DE,
        updated_at: now,
      });
  }
};

exports.down = async function() {
  // No-op: reverting would restore English-as-German. Admins who want
  // different copy can edit it under Settings → Email → Templates.
};
