/**
 * Which generation of the derived-image code a photo's renditions come from
 * (issue 2096).
 *
 * Thumbnails, previews and heroes written before PR 2080 carry the source's
 * EXIF (GPS, camera make, copyright). Renditions written since are stripped,
 * but nothing rewrote the ones already in storage. renditionRefresh walks the
 * rows below the current version in the background, regenerates their
 * renditions and raises the number.
 *
 *   0  renditions may carry the source's EXIF (every row present now)
 *   1  renditions are stripped (the default, so a photo added from here on
 *      never needs the pass)
 *
 * Adding the column with its default fills existing rows with 1 on both
 * engines, so they are set to 0 right after, in the same guarded branch: a
 * re-run finds the column and leaves already-refreshed rows alone.
 *
 * Both steps in one transaction. The runners give a migration one only on
 * PostgreSQL; on SQLite a backfill that failed after the column was added
 * would leave every legacy row at 1, and the re-run would skip it for good.
 */
exports.up = async function up(knex) {
  const addAndBackfill = async (trx) => {
    const has = await trx.schema.hasColumn('photos', 'rendition_version');
    if (has) return;
    await trx.schema.alterTable('photos', (t) => {
      t.integer('rendition_version').notNullable().defaultTo(1);
    });
    await trx('photos').update({ rendition_version: 0 });
  };
  if (knex.isTransaction) await addAndBackfill(knex);
  else await knex.transaction(addAndBackfill);
};

exports.down = async function down(knex) {
  const has = await knex.schema.hasColumn('photos', 'rendition_version');
  if (has) {
    await knex.schema.alterTable('photos', (t) => {
      t.dropColumn('rendition_version');
    });
  }
};
