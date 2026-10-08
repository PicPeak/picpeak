exports.up = async function(knex) {
  if (!(await knex.schema.hasTable('image_work_lock'))) {
    await knex.schema.createTable('image_work_lock', table => {
      table.integer('id').primary();
      table.integer('revision').notNullable().defaultTo(0);
    });
  }
  if (!(await knex('image_work_lock').where({ id: 1 }).first())) await knex('image_work_lock').insert({ id: 1 });
  if (!(await knex.schema.hasTable('image_work_reservations'))) {
    await knex.schema.createTable('image_work_reservations', table => {
      table.string('id', 36).primary();
      // Keep unknown/in-flight reservations even when a catalogue row goes
      // away. No age-based cleanup can free a still-live writer's capacity.
      table.integer('event_id').notNullable().index();
      table.integer('photo_id').nullable().index();
      table.bigInteger('decoded_bytes').notNullable();
      table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    });
  }
  if (!(await knex.schema.hasColumn('photos', 'processing_attempts'))) {
    await knex.schema.alterTable('photos', table => table.integer('processing_attempts').notNullable().defaultTo(0));
  }
};
exports.down = async function(knex) {
  await knex.schema.dropTableIfExists('image_work_reservations');
  await knex.schema.dropTableIfExists('image_work_lock');
  if (await knex.schema.hasColumn('photos', 'processing_attempts')) {
    await knex.schema.alterTable('photos', table => table.dropColumn('processing_attempts'));
  }
};
