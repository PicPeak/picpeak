'use strict';
/**
 * Content-aware cropping (issue 2377). The point of a photo a crop has to keep
 * in view, as fractions of the oriented image (0..1 from the left and top
 * edge). focal_source says who set it: 'auto' (sharp's attention strategy,
 * computed once when the thumbnail is made) or 'manual' (an admin), which an
 * automatic pass never overwrites. NULL everywhere is the centre crop every
 * existing photo keeps until its thumbnail is regenerated.
 *
 * Doubles, not decimals: PostgreSQL hands NUMERIC back as a string.
 */
const COLUMNS = ['focal_x', 'focal_y', 'focal_source'];

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('photos'))) return;
  for (const column of COLUMNS) {
    if (await knex.schema.hasColumn('photos', column)) continue;
    await knex.schema.alterTable('photos', (t) => {
      if (column === 'focal_source') t.string('focal_source', 16).nullable().defaultTo(null);
      else t.double(column).nullable().defaultTo(null);
    });
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('photos'))) return;
  for (const column of COLUMNS) {
    if (!(await knex.schema.hasColumn('photos', column))) continue;
    await knex.schema.alterTable('photos', (t) => t.dropColumn(column));
  }
};
