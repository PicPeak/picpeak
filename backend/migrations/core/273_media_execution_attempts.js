exports.up = async function(knex) {
  const web = await knex.schema.hasColumn('photos', 'web_status');
  for (const field of web ? ['processing_attempt_id', 'web_attempt_id'] : ['processing_attempt_id']) {
    if (!(await knex.schema.hasColumn('photos', field))) await knex.schema.alterTable('photos', table => table.string(field, 36).nullable().index());
  }
  if (web && !(await knex.schema.hasColumn('photos', 'web_attempts'))) await knex.schema.alterTable('photos', table => table.integer('web_attempts').notNullable().defaultTo(0));
  if (!(await knex.schema.hasTable('media_process_attempts'))) {
    await knex.schema.createTable('media_process_attempts', table => {
      table.string('id', 36).primary();
      // Retain unknown executions even if a catalogue row is removed.
      table.integer('photo_id').notNullable().index();
      table.string('kind', 16).notNullable();
      table.text('owner_json').notNullable();
      table.text('children_json').notNullable().defaultTo('[]');
      table.string('lease_path', 1024).notNullable();
      table.string('lease_device', 32).notNullable();
      table.string('lease_inode', 32).notNullable();
      table.string('lease_filesystem', 32).notNullable();
      table.string('state', 16).notNullable().defaultTo('active');
      table.timestamp('heartbeat_at').notNullable().defaultTo(knex.fn.now());
      table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    });
  }
  if (!(await knex.schema.hasTable('media_video_work_reservations'))) {
    await knex.schema.createTable('media_video_work_reservations', table => {
      table.string('id', 36).primary(); table.integer('event_id').notNullable().index();
      table.integer('photo_id').nullable().index(); table.bigInteger('work_units').notNullable();
      table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    });
  }
};
exports.down = async function(knex) {
  await knex.schema.dropTableIfExists('media_video_work_reservations');
  await knex.schema.dropTableIfExists('media_process_attempts');
  for (const field of ['processing_attempt_id', 'web_attempt_id', 'web_attempts']) {
    if (await knex.schema.hasColumn('photos', field)) await knex.schema.alterTable('photos', table => table.dropColumn(field));
  }
};
