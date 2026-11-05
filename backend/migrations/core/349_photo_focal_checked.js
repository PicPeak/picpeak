'use strict';
/**
 * Migration 349: which photos the focal point backfill still has to look at
 * (issue 2377).
 *
 * Migration 348 added the focal point, and every thumbnail cut since detects
 * one. Photos already in the library keep the centre crop until their
 * thumbnail is rebuilt; focalPointBackfill walks them once in the background.
 *   0  not looked at yet (rows without a point when this runs)
 *   1  looked at (the default, so a photo added from here on, whose upload
 *      detects its point, never needs the pass)
 * The column is added with its default and the rows without a point are set
 * to 0 right after, in one transaction, as migration 311 does: a re-run finds
 * the column and leaves rows the backfill already did alone.
 */
exports.up = async function up(knex) {
  const addAndMark = async (trx) => {
    if (!(await trx.schema.hasTable('photos'))) return;
    if (await trx.schema.hasColumn('photos', 'focal_checked')) return;
    await trx.schema.alterTable('photos', (t) => {
      t.integer('focal_checked').notNullable().defaultTo(1);
    });
    await trx('photos').whereNull('focal_source').update({ focal_checked: 0 });
  };
  if (knex.isTransaction) await addAndMark(knex);
  else await knex.transaction(addAndMark);
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('photos'))) return;
  if (!(await knex.schema.hasColumn('photos', 'focal_checked'))) return;
  await knex.schema.alterTable('photos', (t) => {
    t.dropColumn('focal_checked');
  });
};
