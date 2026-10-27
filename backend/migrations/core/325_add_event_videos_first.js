/**
 * Issue 2263: per-event "show videos first". When on, the gallery lists
 * every video ahead of the photos and applies the chosen sort within each
 * group. Default off, so every existing gallery keeps its order.
 *
 * Numbered 325: open PRs already hold 324.
 */
exports.up = async function up(knex) {
  const has = await knex.schema.hasColumn('events', 'videos_first');
  if (!has) {
    await knex.schema.alterTable('events', (t) => {
      t.boolean('videos_first').notNullable().defaultTo(false);
    });
  }
};

exports.down = async function down(knex) {
  const has = await knex.schema.hasColumn('events', 'videos_first');
  if (has) {
    await knex.schema.alterTable('events', (t) => {
      t.dropColumn('videos_first');
    });
  }
};
