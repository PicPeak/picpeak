exports.up = async function(knex) {
  // Execution fencing for the photo queue and, where the web-rendition
  // feature exists, its queue: the id of the attempt that owns a row, and
  // for renditions the same claim counter and retry time photos already have.
  const web = await knex.schema.hasColumn('photos', 'web_status');
  for (const field of web ? ['processing_attempt_id', 'web_attempt_id'] : ['processing_attempt_id']) {
    if (!(await knex.schema.hasColumn('photos', field))) await knex.schema.alterTable('photos', table => table.string(field, 36).nullable().index());
  }
  if (web && !(await knex.schema.hasColumn('photos', 'web_attempts'))) await knex.schema.alterTable('photos', table => table.integer('web_attempts').notNullable().defaultTo(0));
  if (web && !(await knex.schema.hasColumn('photos', 'web_retry_at'))) await knex.schema.alterTable('photos', table => table.timestamp('web_retry_at').nullable());
  if (!(await knex.schema.hasTable('media_process_attempts'))) {
    await knex.schema.createTable('media_process_attempts', table => {
      // One row per running attempt; removed when the attempt ends.
      table.string('id', 36).primary();
      table.integer('photo_id').notNullable().index();
      table.string('kind', 16).notNullable();
      table.text('owner_json').notNullable();
      table.text('children_json').notNullable().defaultTo('[]');
      // Empty where the host has no kernel leases.
      table.string('lease_path', 1024).notNullable();
      table.string('lease_device', 32).notNullable();
      table.string('lease_inode', 32).notNullable();
      table.string('lease_filesystem', 32).notNullable();
      table.string('state', 16).notNullable().defaultTo('active');
      table.timestamp('heartbeat_at').notNullable().defaultTo(knex.fn.now());
      table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    });
  }
};
exports.down = async function(knex) {
  await knex.schema.dropTableIfExists('media_process_attempts');
  for (const field of ['processing_attempt_id', 'web_attempt_id', 'web_attempts', 'web_retry_at']) {
    if (await knex.schema.hasColumn('photos', field)) await knex.schema.alterTable('photos', table => table.dropColumn(field));
  }
};
