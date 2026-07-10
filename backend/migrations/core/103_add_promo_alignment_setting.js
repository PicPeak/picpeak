/**
 * Migration: Promotional banner text alignment (#482).
 *
 * Adds `branding_promo_alignment` to app_settings — admin-controlled
 * horizontal alignment for the gallery promotional banner content
 * (#440 / #482). Reuses the existing app_settings shape that
 * branding_promo_markdown / branding_promo_position already use.
 *
 * Default 'center' so the banner aligns with the gallery footer
 * (which is full-width center-aligned). The previous default left
 * the markdown left-aligned in a max-w-3xl block, which Rekoo-PS
 * reported as visually offset from the footer.
 *
 * Allowed values: 'left' | 'center' | 'right' — validated on the
 * write path in adminSettings.js, not enforced by the column type
 * (we use varchar instead of CHECK so the value can be extended
 * later — e.g. 'justify' — without another schema migration).
 *
 * Idempotent: skips the insert when the row already exists.
 */

exports.up = async function(knex) {
  if (!(await knex.schema.hasTable('app_settings'))) return;

  const existing = await knex('app_settings')
    .where('setting_key', 'branding_promo_alignment')
    .first();
  if (existing) return;

  await knex('app_settings').insert({
    setting_key: 'branding_promo_alignment',
    setting_value: JSON.stringify('center'),
    setting_type: 'branding',
    updated_at: new Date(),
  });
};

exports.down = async function(knex) {
  if (!(await knex.schema.hasTable('app_settings'))) return;
  await knex('app_settings')
    .where('setting_key', 'branding_promo_alignment')
    .del();
};
