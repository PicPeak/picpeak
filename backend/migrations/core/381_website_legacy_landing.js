/**
 * Website builder, issue 2618: the single-page landing page moves into the
 * website builder.
 *
 *   - An install that uses the landing page (switched on, or its HTML or CSS
 *     edited from what migration 043 seeds) gets the `websiteBuilder` flag
 *     switched on and its page imported as the website's draft, by the same
 *     rules the builder applies on first open (document.js legacyImport),
 *     including leaving a page too long for a custom-HTML block uncut and
 *     un-imported. Nothing is published: `/` keeps serving the old page
 *     until someone publishes from the builder.
 *   - `website_legacy_landing_migrated` marks such an install, so its admins
 *     are told where the page went (until they publish or dismiss it).
 *   - `admin_notice_dismissals`: per-admin dismissal of such notices.
 *
 * Idempotent: an existing draft is never replaced, the flag and the marker
 * are only set. down() drops the table and the marker; the flag and an
 * imported draft stay (irreversible by design: someone may have edited it).
 */
const { formatBoolean } = require('../../src/utils/dbCompat');
const { legacyImport, normalizeDocument } = require('../../src/services/website/document');

const MARKER = 'website_legacy_landing_migrated';

// Settings are stored JSON-encoded; an older row may hold the bare string.
function settingValue(row) {
  if (!row) return undefined;
  try { return JSON.parse(row.setting_value); } catch { return row.setting_value; }
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('admin_notice_dismissals'))) {
    await knex.schema.createTable('admin_notice_dismissals', (t) => {
      t.increments('id').primary();
      t.integer('admin_id').notNullable();
      t.string('notice_key', 64).notNullable();
      t.string('dismissed_at', 40).notNullable();
      t.unique(['admin_id', 'notice_key']);
    });
  }
  if (!(await knex.schema.hasTable('app_settings')) || !(await knex.schema.hasTable('website_documents'))) return;
  const rows = await knex('app_settings')
    .whereIn('setting_key', ['general_public_site_enabled', 'general_public_site_html', 'general_public_site_custom_css']);
  const byKey = Object.fromEntries(rows.map((row) => [row.setting_key, settingValue(row)]));
  const enabled = byKey.general_public_site_enabled === true || byKey.general_public_site_enabled === 1
    || byKey.general_public_site_enabled === 'true' || byKey.general_public_site_enabled === '1';
  const legacy = legacyImport({ enabled, html: byKey.general_public_site_html, css: byKey.general_public_site_custom_css });
  if (!legacy.used) return;

  const now = new Date().toISOString();
  if (await knex.schema.hasTable('feature_flags')) {
    const flag = await knex('feature_flags').where({ key: 'websiteBuilder' }).first();
    if (flag) await knex('feature_flags').where({ key: 'websiteBuilder' }).update({ value: formatBoolean(true) });
    else await knex('feature_flags').insert({ key: 'websiteBuilder', value: formatBoolean(true) });
  }
  if (!(await knex('app_settings').where({ setting_key: MARKER }).first())) {
    await knex('app_settings').insert({ setting_key: MARKER, setting_value: JSON.stringify(true), setting_type: 'general', updated_at: now });
  }
  if (legacy.document && !(await knex('website_documents').where({ state: 'draft' }).first())) {
    await knex('website_documents').insert({
      state: 'draft', document: JSON.stringify(normalizeDocument(legacy.document).document), revision: 1, updated_by: null, updated_at: now,
    });
  }
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('admin_notice_dismissals');
  if (await knex.schema.hasTable('app_settings')) await knex('app_settings').where({ setting_key: MARKER }).del();
};
