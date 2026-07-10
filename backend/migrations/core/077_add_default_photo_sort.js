exports.up = async function(knex) {
  const hasColumn = await knex.schema.hasColumn('events', 'default_photo_sort');
  if (!hasColumn) {
    await knex.schema.alterTable('events', (table) => {
      table.string('default_photo_sort', 50).defaultTo('upload_date_desc');
    });
  }
};

exports.down = async function(knex) {
  const hasColumn = await knex.schema.hasColumn('events', 'default_photo_sort');
  if (hasColumn) {
    await knex.schema.alterTable('events', (table) => {
      table.dropColumn('default_photo_sort');
    });
  }
};
