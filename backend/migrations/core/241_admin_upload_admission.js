exports.up = async function(knex) {
  for (const name of ['public_upload_requests', 'public_upload_objects']) {
    for (const column of ['staging_bytes', 'staging_files']) {
      if (!(await knex.schema.hasColumn(name, column))) {
        await knex.schema.alterTable(name, table => {
          // NULL represents an existing claim; runtime accounts it with the
          // conservative legacy copy allowance, never as zero free capacity.
          if (column === 'staging_bytes') table.bigInteger(column).nullable();
          else table.integer(column).nullable();
        });
      }
    }
  }
  if (!(await knex.schema.hasColumn('public_upload_requests', 'upload_kind'))) {
    await knex.schema.alterTable('public_upload_requests', table => {
      table.string('upload_kind', 20).notNullable().defaultTo('public').index();
    });
  }
  if (!(await knex.schema.hasColumn('public_upload_requests', 'upload_shape'))) {
    await knex.schema.alterTable('public_upload_requests', table => {
      table.string('upload_shape', 20).notNullable().defaultTo('multipart');
    });
  }
};

exports.down = async function(knex) {
  for (const name of ['public_upload_requests', 'public_upload_objects']) {
    for (const column of ['staging_bytes', 'staging_files']) {
      if (await knex.schema.hasColumn(name, column)) await knex.schema.alterTable(name, table => table.dropColumn(column));
    }
  }
  if (await knex.schema.hasColumn('public_upload_requests', 'upload_kind')) {
    await knex.schema.alterTable('public_upload_requests', table => table.dropColumn('upload_kind'));
  }
  if (await knex.schema.hasColumn('public_upload_requests', 'upload_shape')) {
    await knex.schema.alterTable('public_upload_requests', table => table.dropColumn('upload_shape'));
  }
};
