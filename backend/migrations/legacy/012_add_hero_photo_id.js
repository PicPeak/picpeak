exports.up = async function(knex) {
  // Add hero_photo_id to events table
  const hasColumn = await knex.schema.hasColumn('events', 'hero_photo_id');
  if (!hasColumn) {
    await knex.schema.alterTable('events', function(table) {
      table.integer('hero_photo_id').references('id').inTable('photos').onDelete('SET NULL');
    });
  }
};

exports.down = async function(knex) {
  await knex.schema.alterTable('events', function(table) {
    table.dropColumn('hero_photo_id');
  });
};