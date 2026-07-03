/**
 * Migration: Expand hero_image_anchor column to support focal point percentages
 *
 * Changes string(10) to string(20) so values like "100% 100%" (9 chars) fit
 * with room to spare. Existing 'top', 'center', 'bottom' values are preserved.
 */

exports.up = async function(knex) {
  const hasColumn = await knex.schema.hasColumn('events', 'hero_image_anchor');
  if (!hasColumn) {
    // Column doesn't exist yet – nothing to expand
    return;
  }

  // SQLite doesn't truly support ALTER COLUMN, but Knex handles the
  // rebuild-table strategy internally when we call alterTable.
  await knex.schema.alterTable('events', function(table) {
    table.string('hero_image_anchor', 20).defaultTo('center').alter();
  });
  console.log('Expanded hero_image_anchor column to string(20)');
};

exports.down = async function(knex) {
  const hasColumn = await knex.schema.hasColumn('events', 'hero_image_anchor');
  if (!hasColumn) {
    return;
  }

  await knex.schema.alterTable('events', function(table) {
    table.string('hero_image_anchor', 10).defaultTo('center').alter();
  });
};
