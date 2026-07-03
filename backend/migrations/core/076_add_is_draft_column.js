/**
 * Migration to add is_draft column to events table.
 * Draft events are not visible to gallery visitors until published.
 */
exports.up = async function(knex) {
  const hasColumn = await knex.schema.hasColumn('events', 'is_draft');
  if (!hasColumn) {
    await knex.schema.alterTable('events', (table) => {
      table.boolean('is_draft').defaultTo(false);
    });
  }
};

exports.down = async function(knex) {
  const hasColumn = await knex.schema.hasColumn('events', 'is_draft');
  if (hasColumn) {
    await knex.schema.alterTable('events', (table) => {
      table.dropColumn('is_draft');
    });
  }
};
