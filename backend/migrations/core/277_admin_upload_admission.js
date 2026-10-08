// Authenticated (admin, API, resumable) uploads share the public tables for
// staging and concurrency accounting. The kind keeps them out of every public
// allowance; existing rows are public by definition.
const TABLES = ['public_upload_requests', 'public_upload_objects'];

exports.up = async function(knex) {
  for (const name of TABLES) {
    if (!(await knex.schema.hasTable(name)) || await knex.schema.hasColumn(name, 'upload_kind')) continue;
    await knex.schema.alterTable(name, table => {
      table.string('upload_kind', 20).notNullable().defaultTo('public').index();
    });
  }
};

exports.down = async function(knex) {
  for (const name of TABLES) {
    if (await knex.schema.hasTable(name) && await knex.schema.hasColumn(name, 'upload_kind')) {
      await knex.schema.alterTable(name, table => table.dropColumn('upload_kind'));
    }
  }
};
