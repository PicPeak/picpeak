/**
 * Issue 2263, item 4: the admin picks a video's preview image. The poster
 * frame is taken this many seconds into the clip; NULL = the default frame
 * (1 s in, see videoProcessor.DEFAULT_POSTER_OFFSET_SECONDS). Additive, so
 * every existing video keeps its current poster.
 *
 * A double, not a decimal: PostgreSQL hands NUMERIC back as a string.
 */
exports.up = async function up(knex) {
  const has = await knex.schema.hasColumn('photos', 'poster_offset_seconds');
  if (!has) {
    await knex.schema.alterTable('photos', (t) => {
      t.double('poster_offset_seconds').nullable().defaultTo(null);
    });
  }
};

exports.down = async function down(knex) {
  const has = await knex.schema.hasColumn('photos', 'poster_offset_seconds');
  if (has) {
    await knex.schema.alterTable('photos', (t) => {
      t.dropColumn('poster_offset_seconds');
    });
  }
};
