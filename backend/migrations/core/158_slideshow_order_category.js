/**
 * Migration 158: per-event slideshow ordering + category filter (#202).
 *
 * - `show_order`      — 'chronological' (default, upload order) | 'random'
 *                       (client-side shuffle). Lets the Live Slideshow play
 *                       photos in a varied order during an event.
 * - `show_category_id`— optional FK into `photo_categories`. When set, the
 *                       slideshow only shows photos in that category (NULL =
 *                       all visible photos, the existing behaviour).
 *
 * Both additive + guarded. Defaults preserve today's behaviour (chronological,
 * all photos), so existing slideshows are unchanged.
 */
exports.up = async function up(knex) {
  const hasOrder = await knex.schema.hasColumn('events', 'show_order');
  if (!hasOrder) {
    await knex.schema.alterTable('events', (t) => {
      t.string('show_order', 20).defaultTo('chronological');
    });
  }
  const hasCat = await knex.schema.hasColumn('events', 'show_category_id');
  if (!hasCat) {
    await knex.schema.alterTable('events', (t) => {
      t.integer('show_category_id').nullable();
    });
  }
};

exports.down = async function down(knex) {
  for (const col of ['show_order', 'show_category_id']) {
    // eslint-disable-next-line no-await-in-loop
    if (await knex.schema.hasColumn('events', col)) {
      // eslint-disable-next-line no-await-in-loop
      await knex.schema.alterTable('events', (t) => t.dropColumn(col));
    }
  }
};
