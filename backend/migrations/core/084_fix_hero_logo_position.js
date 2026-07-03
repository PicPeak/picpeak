/**
 * Heal events whose hero_logo_position contains a branding-style value
 * (left/right) caused by a prior bug in adminEvents.js getBrandingDefaults
 * that mapped branding_logo_position (left/center/right) onto
 * hero_logo_position (top/center/bottom). Any non-canonical value is
 * reset to 'top' so subsequent PUTs no longer fail validation.
 */

exports.up = async function up(knex) {
  const hasColumn = await knex.schema.hasColumn('events', 'hero_logo_position');
  if (!hasColumn) return;

  await knex('events')
    .whereNotIn('hero_logo_position', ['top', 'center', 'bottom'])
    .update({ hero_logo_position: 'top' });
};

exports.down = async function down() {
  // Data correction is not reversible — the original (incorrect) values
  // are not preserved.
};
