exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('product_usage_state'))) {
    await knex.schema.createTable('product_usage_state', (t) => {
      t.integer('id').primary();
      t.string('status', 30).notNullable().defaultTo('disabled');
      t.boolean('notice_dismissed').notNullable().defaultTo(false);
      t.string('installation_id', 64);
      t.string('public_key', 59);
      t.text('private_key_encrypted');
      t.string('instance_binding', 64);
      t.bigInteger('sequence').notNullable().defaultTo(0);
      t.text('pending_packet');
      t.text('last_packet');
      t.text('last_receipt');
      t.string('last_report_date', 10);
      t.string('last_error', 80);
      t.text('feedback_preferences');
      t.string('lease_token', 36);
      t.bigInteger('lease_until').notNullable().defaultTo(0);
    });
  }
  if (!(await knex('product_usage_state').where({ id: 1 }).first()))
    await knex('product_usage_state').insert({ id: 1 });
  if (!(await knex.schema.hasTable('product_usage_markers'))) {
    await knex.schema.createTable('product_usage_markers', (t) => {
      t.string('feature', 60).primary();
      // A marker is only a capability name, never a timestamp or user/event ID.
    });
  }
};
exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('product_usage_markers');
  await knex.schema.dropTableIfExists('product_usage_state');
};
