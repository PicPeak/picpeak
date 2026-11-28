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
 *   - backup path `fonts`: fonts uploaded in the branding settings.
 *   - `website_page_views`: the website's page views, counted server-side per
 *     day, page, referrer domain and device class. Nothing about a visitor
 *     (no address, agent string or cookie) has a column to land in.
 *
 * Idempotent: an existing draft is never replaced, the flag and the marker
 * are only set. down() drops the tables and the marker; the flag and an
 * imported draft stay (irreversible by design: someone may have edited it).
 */
// A snapshot, not the application's code: what the landing page's defaults
// were, and how the builder imports a landing page, when this was written.
const crypto = require('crypto');
const { DEFAULT_PUBLIC_SITE_HTML, DEFAULT_PUBLIC_SITE_CSS } = require('./snapshots/381_public_site_defaults');

const MAX_CUSTOM_HTML = 100 * 1024;
const newId = () => crypto.randomBytes(6).toString('hex');
// A boolean as the engine stores it (dbCompat.formatBoolean).
const formatBooleanFor = (knex) => (value) => (knex.client.config.client === 'pg' ? value : (value ? 1 : 0));

/**
 * The import (document.js legacyImport) and the stored shape the builder
 * gives it (normalizeDocument), as of this migration: one home page with the
 * page as a legacy custom HTML block, the menu made from it, the footer as it
 * always was, the default stylesheet before the page's own.
 */
function legacyImport({ enabled, html, css }) {
  const page = typeof html === 'string' ? html : '';
  const style = typeof css === 'string' ? css : '';
  const used = !!page.trim() && (enabled || page.trim() !== DEFAULT_PUBLIC_SITE_HTML.trim() || !!style.trim());
  if (!used) return { used: false };
  if (page.length > MAX_CUSTOM_HTML) return { used: true, refused: true };
  const pageId = newId();
  return {
    used: true,
    document: {
      version: 1,
      pages: [{
        id: pageId, slug: 'home', title: 'Home', navLabel: '', hidden: false, isHome: true,
        seo: { title: '', description: '', image: null },
        blocks: [{ id: newId(), type: 'customHtml', variant: 'default', background: 'default', html: page, legacy: true }],
      }],
      menu: {
        layout: 'left', style: 'plain', sticky: true, transparent: false, mobile: 'dropdown', background: null, text: null,
        items: [{ id: pageId, label: '', hidden: false, target: { kind: 'page', pageId } }],
      },
      footer: {
        columns: [{ id: 'brand', kind: 'brand', heading: '' }, { id: 'pages', kind: 'pages', heading: '' }],
        legal: 'column', copyright: '', background: 'default',
      },
      theme: { headingFont: null, bodyFont: null, buttonStyle: null, accent: null, background: null, text: null },
      customCss: `${DEFAULT_PUBLIC_SITE_CSS}\n\n${style}`.trim(),
    },
  };
}

const MARKER = 'website_legacy_landing_migrated';

// Settings are stored JSON-encoded; an older row may hold the bare string.
function settingValue(row) {
  if (!row) return undefined;
  try { return JSON.parse(row.setting_value); } catch { return row.setting_value; }
}

exports.up = async function up(knex) {
  const formatBoolean = formatBooleanFor(knex);
  if (!(await knex.schema.hasTable('admin_notice_dismissals'))) {
    await knex.schema.createTable('admin_notice_dismissals', (t) => {
      t.increments('id').primary();
      t.integer('admin_id').notNullable();
      t.string('notice_key', 64).notNullable();
      t.string('dismissed_at', 40).notNullable();
      t.unique(['admin_id', 'notice_key']);
    });
  }
  if (!(await knex.schema.hasTable('website_page_views'))) {
    await knex.schema.createTable('website_page_views', (t) => {
      t.increments('id').primary();
      t.string('day', 10).notNullable();
      t.string('page', 80).notNullable();
      t.string('referrer', 100).notNullable();
      t.string('device', 10).notNullable();
      t.integer('views').notNullable().defaultTo(0);
      t.unique(['day', 'page', 'referrer', 'device']);
    });
  }
  // Fonts uploaded in the branding settings live in fonts/: back them up.
  if (await knex.schema.hasTable('backup_paths')) {
    await knex('backup_paths').insert({
      path: 'fonts', include_in_default: formatBoolean(true), feature_flag: null, display_order: 125, description: 'Uploaded fonts',
    }).onConflict('path').ignore();
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
      state: 'draft', document: JSON.stringify(legacy.document), revision: 1, updated_by: null, updated_at: now,
    });
  }
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('admin_notice_dismissals');
  await knex.schema.dropTableIfExists('website_page_views');
  if (await knex.schema.hasTable('app_settings')) await knex('app_settings').where({ setting_key: MARKER }).del();
};
