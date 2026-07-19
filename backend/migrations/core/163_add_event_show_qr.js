/**
 * #837 — per-event override for the live-slideshow QR overlay.
 * Mirrors show_watermark: NULL = inherit the global slideshow_qr_enabled
 * setting, true/false force the overlay on/off for this event.
 */
exports.up = async function up(knex) {
  const has = await knex.schema.hasColumn('events', 'show_qr');
  if (!has) {
    await knex.schema.alterTable('events', (t) => {
      t.boolean('show_qr').nullable().defaultTo(null);
    });
  }
};

exports.down = async function down(knex) {
  const has = await knex.schema.hasColumn('events', 'show_qr');
  if (has) {
    await knex.schema.alterTable('events', (t) => {
      t.dropColumn('show_qr');
    });
  }
};
