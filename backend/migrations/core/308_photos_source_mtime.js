/**
 * The modification time of an external (NAS) photo's file, next to its
 * size (issue 2059).
 *
 * An import pass tells a file edited in place by comparing it with what it
 * recorded, and the derivative keys and publish guards carry the same
 * version. Size alone misses an edit that keeps the byte count (a rating
 * or keyword rewritten into the file). Milliseconds since the epoch, as
 * an integer: bigInteger, because the value does not fit a 32-bit column.
 * NULL on managed rows and on external rows imported before this; the
 * next pass records it for those.
 */
exports.up = async function up(knex) {
  const has = await knex.schema.hasColumn('photos', 'source_mtime_ms');
  if (!has) {
    await knex.schema.alterTable('photos', (t) => {
      t.bigInteger('source_mtime_ms').nullable();
    });
  }
};

exports.down = async function down(knex) {
  const has = await knex.schema.hasColumn('photos', 'source_mtime_ms');
  if (has) {
    await knex.schema.alterTable('photos', (t) => {
      t.dropColumn('source_mtime_ms');
    });
  }
};
