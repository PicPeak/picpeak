/**
 * Issue 2261: per-event override for how live-slideshow slides fill the
 * screen. Mirrors show_qr: NULL = inherit the global slideshow_fit setting;
 * 'auto' | 'contain' | 'cover' force a mode for this event. Additive, so
 * every existing event keeps following the global setting.
 *
 * Numbered 323, not 316: open inbound PRs already hold 316-322.
 */
exports.up = async function up(knex) {
  const has = await knex.schema.hasColumn('events', 'show_fit');
  if (!has) {
    await knex.schema.alterTable('events', (t) => {
      t.string('show_fit', 10).nullable().defaultTo(null);
    });
  }
};

exports.down = async function down(knex) {
  const has = await knex.schema.hasColumn('events', 'show_fit');
  if (has) {
    await knex.schema.alterTable('events', (t) => {
      t.dropColumn('show_fit');
    });
  }
};
