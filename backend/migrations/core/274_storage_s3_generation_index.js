// Target-local runtime representation, never portable application data.
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('storage_s3_generation_index'))) {
    await knex.schema.createTable('storage_s3_generation_index', table => {
      table.integer('id').primary();
      table.string('namespace', 64).notNullable();
      table.string('revision', 36).notNullable();
      table.text('mapping').notNullable();
    });
  }
};

exports.down = async function down(knex) {
  // A populated index is required to find live objects; dropping it would
  // silently expose stale legacy objects. Roll back only unused schemas.
  if (await knex.schema.hasTable('storage_s3_generation_index')) {
    if (await knex('storage_s3_generation_index').first()) {
      throw new Error('Cannot remove the active S3 generation index');
    }
    await knex.schema.dropTable('storage_s3_generation_index');
  }
};
