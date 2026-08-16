/**
 * Migration: gallery info banner (#932)
 *
 * A short informational message rendered ABOVE the photo grid, so guests see
 * it on load. Distinct from the promotional banner (#440), which sits by the
 * footer and stays there for marketing/CTA copy — the reporter's case is an
 * onboarding hint ("use the menu button to filter"), which is useless below a
 * gallery the guest has to scroll past first.
 *
 * Deliberately mirrors the promo columns rather than inventing a second
 * shape: a global default in branding settings plus a per-event
 * inherit/custom/off override. Same semantics, same normalisation, so the
 * two banners stay predictable next to each other.
 *
 * Idempotent (hasColumn / existing-key guarded) so a re-run or a
 * partially-applied state is safe.
 */

exports.up = async function (knex) {
  // 1. events.info_mode — 'inherit' (use the global default) | 'custom'
  //    (this event's own copy) | 'off' (no banner for this gallery).
  const hasInfoMode = await knex.schema.hasColumn('events', 'info_mode');
  if (!hasInfoMode) {
    await knex.schema.alterTable('events', (table) => {
      table.string('info_mode', 16).notNullable().defaultTo('inherit');
    });
    console.log('  added events.info_mode (default "inherit")');
  } else {
    console.log('  events.info_mode already exists, skipping');
  }

  // 2. events.info_markdown — per-event copy, only read when mode = custom.
  const hasInfoMarkdown = await knex.schema.hasColumn('events', 'info_markdown');
  if (!hasInfoMarkdown) {
    await knex.schema.alterTable('events', (table) => {
      table.text('info_markdown').nullable();
    });
    console.log('  added events.info_markdown (nullable text)');
  } else {
    console.log('  events.info_markdown already exists, skipping');
  }

  // 3. The global default, following the existing `branding_<name>`
  //    convention used by the promo rows this mirrors. Empty string = the
  //    banner is off everywhere until an admin fills it in, so upgrading
  //    changes nothing visible for existing installs.
  const infoSetting = {
    setting_key: 'branding_info_markdown',
    setting_value: JSON.stringify(''),
    setting_type: 'branding',
  };
  const exists = await knex('app_settings').where('setting_key', infoSetting.setting_key).first();
  if (!exists) {
    await knex('app_settings').insert({ ...infoSetting, updated_at: knex.fn.now() });
    console.log('  added branding_info_markdown (empty = banner off)');
  } else {
    console.log('  branding_info_markdown already exists, skipping');
  }

  console.log('Migration 176_gallery_info_banner completed');
};

exports.down = async function (knex) {
  console.log('Rollback: 176_gallery_info_banner');

  if (await knex.schema.hasTable('events')) {
    if (await knex.schema.hasColumn('events', 'info_markdown')) {
      await knex.schema.alterTable('events', (table) => table.dropColumn('info_markdown'));
    }
    if (await knex.schema.hasColumn('events', 'info_mode')) {
      await knex.schema.alterTable('events', (table) => table.dropColumn('info_mode'));
    }
  }

  if (await knex.schema.hasTable('app_settings')) {
    await knex('app_settings').where('setting_key', 'branding_info_markdown').del();
  }
};
