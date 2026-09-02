/**
 * Migration 196: give the English (and German) `gallery_created` template the
 * `{{#if welcome_message}}` block every other locale already has.
 *
 * `adminEvents/crud.js:139` puts `welcome_message` on the queued mail payload
 * for every published gallery, and emailProcessor runs it through
 * `formatWelcomeMessage` (escape + nl2br) and treats it as HTML-passthrough.
 * nl/pt/ru/fr/es/sl all render it, via the identical one-liner appended to the
 * end of the HTML body (migrations 075, 099, 106, 108):
 *
 *   {{#if welcome_message}}<p><em>{{welcome_message}}</em></p>{{/if}}
 *
 * The English copy seeded by migration 001 has no such block, and migration
 * 194's German was written against that English — so on a fresh install EN and
 * DE recipients silently lose the photographer's personal note to their client.
 * (Legacy installs are fine: legacy 028/026 both carry a welcome_message block.)
 *
 * `{{#if}}` is a real construct, not wishful markup: `safeTemplateReplace`
 * (emailProcessor.js:515) resolves `{{#if var}}…{{/if}}` before variable
 * substitution and drops the block when the variable is empty — so an event
 * with no welcome message renders exactly as it does today.
 *
 * HTML body only, like the other six locales — and deliberately so:
 * emailProcessor rewrites `welcome_message` through `formatWelcomeMessage`
 * (HTML-escape + nl2br) once, for both bodies, so dropping it into the plain
 * text part would print literal `<br />` and `&amp;`.
 *
 * Conservative in the same way as 194/195: each body is rewritten only while
 * it is still byte-identical to the copy this codebase seeded, so an
 * admin-edited template is never clobbered. The declared `variables` array
 * gains `welcome_message` unconditionally-if-absent — it is not admin-editable
 * for seeded templates, and the six locales that already reference the
 * variable need it declared for the Templates preview to substitute it.
 */

const WELCOME_BLOCK = '\n{{#if welcome_message}}<p><em>{{welcome_message}}</em></p>{{/if}}';

// The English body seeded by migration 001, verbatim.
const SEEDED_HTML_EN = `<h2>Gallery Created Successfully</h2>
<p>Dear {{host_name}},</p>
<p>Your photo gallery "{{event_name}}" has been created successfully!</p>
<p><strong>Gallery Details:</strong></p>
<ul>
  <li>Event Date: {{event_date}}</li>
  <li>Gallery Link: {{gallery_link}}</li>
  <li>Password: {{gallery_password}}</li>
  <li>Expires: {{expiry_date}}</li>
</ul>
<p>Share this link and password with your guests to allow them to view and download photos.</p>`;

// The German body written by migration 194, verbatim.
const SEEDED_HTML_DE = `<h2>Galerie erfolgreich erstellt</h2>
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

const SEEDED = { en: SEEDED_HTML_EN, de: SEEDED_HTML_DE };

exports.up = async function(knex) {
  if (!(await knex.schema.hasTable('email_templates'))) return;

  const master = await knex('email_templates')
    .where('template_key', 'gallery_created')
    .first();
  if (!master) return;

  const now = new Date().toISOString();

  if (await knex.schema.hasTable('email_template_translations')) {
    for (const [language, seededHtml] of Object.entries(SEEDED)) {
      const row = await knex('email_template_translations')
        .where({ template_id: master.id, language })
        .first();
      if (!row || (row.body_html || '') !== seededHtml) continue;
      await knex('email_template_translations')
        .where({ id: row.id })
        .update({ body_html: seededHtml + WELCOME_BLOCK, updated_at: now });
    }
  }

  // Legacy per-language columns — emailProcessor's fallback path.
  const cols = await knex('email_templates').columnInfo();
  const columnUpdate = {};
  if (cols.body_html_en && (master.body_html_en || '') === SEEDED_HTML_EN) {
    columnUpdate.body_html_en = SEEDED_HTML_EN + WELCOME_BLOCK;
  }
  if (cols.body_html_de && (master.body_html_de || '') === SEEDED_HTML_DE) {
    columnUpdate.body_html_de = SEEDED_HTML_DE + WELCOME_BLOCK;
  }
  if (Object.keys(columnUpdate).length > 0) {
    columnUpdate.updated_at = now;
    await knex('email_templates').where({ id: master.id }).update(columnUpdate);
  }

  // Declare the variable the template (and six other locales) now reference.
  let variables = master.variables;
  if (typeof variables === 'string') {
    try { variables = JSON.parse(variables); } catch (e) { variables = null; }
  }
  if (Array.isArray(variables) && !variables.includes('welcome_message')) {
    await knex('email_templates')
      .where({ id: master.id })
      .update({ variables: JSON.stringify([...variables, 'welcome_message']), updated_at: now });
  }
};

exports.down = async function() {
  // No-op: reverting would drop the photographer's personal note from the mail
  // again. Admins who don't want it can remove the block under
  // Settings → Email → Templates.
};
