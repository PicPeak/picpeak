/**
 * Migration 089: Footer overhaul (#441 + #440).
 *
 * Three concerns, all in the gallery footer area:
 *
 * 1. Per-CMS-page "Show in footer" toggle (#441 part a). Lets admins
 *    hide legal-link entries (Impressum, Datenschutz, etc.) when the
 *    target jurisdiction doesn't require them. Default TRUE so existing
 *    installs see no change.
 *
 * 2. Social links in the footer (#441 part b). Five branding settings
 *    for the canonical photographer-relevant networks: Facebook,
 *    Instagram, WhatsApp, X/Twitter, YouTube. All optional strings.
 *
 * 3. Promotional markdown slot above/below the footer (#440). Global
 *    default + per-event override with a three-way mode switch:
 *      - inherit (default): use the global, render nothing if global empty
 *      - custom:            render the per-event markdown
 *      - off:               suppress entirely for this event regardless of global
 *
 *    Markdown only (no raw HTML) — the rendering pipeline is
 *    `marked → DOMPurify` on the frontend so admins can format text
 *    without opening an XSS surface.
 */

exports.up = async function(knex) {
  console.log('Running migration: 089_footer_overhaul');

  // 1. cms_pages.show_in_footer
  const hasShowInFooter = await knex.schema.hasColumn('cms_pages', 'show_in_footer');
  if (!hasShowInFooter) {
    await knex.schema.alterTable('cms_pages', (table) => {
      table.boolean('show_in_footer').notNullable().defaultTo(true);
    });
    console.log('  added cms_pages.show_in_footer (default true)');
  } else {
    console.log('  cms_pages.show_in_footer already exists, skipping');
  }

  // 2. events.promo_mode + events.promo_markdown
  const hasPromoMode = await knex.schema.hasColumn('events', 'promo_mode');
  if (!hasPromoMode) {
    await knex.schema.alterTable('events', (table) => {
      table.string('promo_mode', 16).notNullable().defaultTo('inherit');
    });
    console.log('  added events.promo_mode (default "inherit")');
  } else {
    console.log('  events.promo_mode already exists, skipping');
  }

  const hasPromoMarkdown = await knex.schema.hasColumn('events', 'promo_markdown');
  if (!hasPromoMarkdown) {
    await knex.schema.alterTable('events', (table) => {
      table.text('promo_markdown').nullable();
    });
    console.log('  added events.promo_markdown (nullable text)');
  } else {
    console.log('  events.promo_markdown already exists, skipping');
  }

  // 3. New branding settings rows. Use the same `branding_<name>`
  //    convention as the existing 21 branding rows (verified via
  //    SELECT setting_key FROM app_settings WHERE setting_key LIKE 'branding_%').
  const newSettings = [
    { setting_key: 'branding_facebook_url',   setting_value: JSON.stringify(''), setting_type: 'branding' },
    { setting_key: 'branding_instagram_url',  setting_value: JSON.stringify(''), setting_type: 'branding' },
    { setting_key: 'branding_whatsapp_url',   setting_value: JSON.stringify(''), setting_type: 'branding' },
    { setting_key: 'branding_twitter_url',    setting_value: JSON.stringify(''), setting_type: 'branding' },
    { setting_key: 'branding_youtube_url',    setting_value: JSON.stringify(''), setting_type: 'branding' },
    { setting_key: 'branding_promo_markdown', setting_value: JSON.stringify(''), setting_type: 'branding' },
    // 'above_footer' | 'below_footer' (string instead of enum so we can
    // expand without a schema change later).
    { setting_key: 'branding_promo_position', setting_value: JSON.stringify('above_footer'), setting_type: 'branding' },
  ];

  for (const setting of newSettings) {
    const exists = await knex('app_settings').where('setting_key', setting.setting_key).first();
    if (!exists) {
      await knex('app_settings').insert({ ...setting, updated_at: knex.fn.now() });
    }
  }
  console.log(`  ensured ${newSettings.length} branding rows`);

  console.log('Migration 089_footer_overhaul completed');
};

exports.down = async function(knex) {
  console.log('Rollback: 089_footer_overhaul');

  if (await knex.schema.hasColumn('cms_pages', 'show_in_footer')) {
    await knex.schema.alterTable('cms_pages', (table) => {
      table.dropColumn('show_in_footer');
    });
  }

  if (await knex.schema.hasColumn('events', 'promo_mode')) {
    await knex.schema.alterTable('events', (table) => {
      table.dropColumn('promo_mode');
    });
  }

  if (await knex.schema.hasColumn('events', 'promo_markdown')) {
    await knex.schema.alterTable('events', (table) => {
      table.dropColumn('promo_markdown');
    });
  }

  await knex('app_settings')
    .whereIn('setting_key', [
      'branding_facebook_url',
      'branding_instagram_url',
      'branding_whatsapp_url',
      'branding_twitter_url',
      'branding_youtube_url',
      'branding_promo_markdown',
      'branding_promo_position',
    ])
    .del();
};
