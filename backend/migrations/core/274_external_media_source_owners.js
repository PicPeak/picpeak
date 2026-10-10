// Historical external_path values were chosen without source authorization.
// Never turn them into grants; an instance owner must assign sources explicitly.
exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('external_media_sources'))) {
    await knex.schema.createTable('external_media_sources', (table) => {
      table.increments('id').primary();
      table.string('path', 1024).notNullable().unique();
      table.integer('owner_id').unsigned().nullable().references('id').inTable('admin_users').onDelete('SET NULL');
      table.timestamp('created_at').defaultTo(knex.fn.now());
    });
  }
  if (!(await knex.schema.hasTable('external_media_source_lock'))) {
    await knex.schema.createTable('external_media_source_lock', (table) => {
      table.integer('id').primary();
      table.integer('revision').notNullable().defaultTo(0);
    });
  }
  await knex('external_media_source_lock').insert({ id: 1, revision: 0 }).onConflict('id').ignore();
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('external_media_sources');
  await knex.schema.dropTableIfExists('external_media_source_lock');
};
