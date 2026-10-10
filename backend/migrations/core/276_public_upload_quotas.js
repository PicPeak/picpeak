// No catalogue foreign keys: a missing row is NOT proof its bytes disappeared.
exports.up = async function(knex) {
  if (!(await knex.schema.hasTable('public_upload_lock'))) {
    await knex.schema.createTable('public_upload_lock', t => {
      t.integer('id').primary();
      t.integer('revision').notNullable().defaultTo(0);
    });
  }
  await knex('public_upload_lock').insert({ id: 1 }).onConflict('id').ignore();
  for (const name of ['public_upload_requests', 'public_upload_objects']) {
    if (await knex.schema.hasTable(name)) continue;
    await knex.schema.createTable(name, t => {
      t.string('id', 36).primary();
      t.integer('event_id').nullable().index();
      t.string('guest_scope', 80).nullable().index();
      t.integer('transfer_id').nullable().index();
      t.integer('account_id').nullable().index();
      t.bigInteger('bytes').notNullable();
      t.integer('files').notNullable();
      t.timestamp('created_at').notNullable().defaultTo(knex.fn.now()).index();
      if (name === 'public_upload_requests') {
        t.integer('active').notNullable().defaultTo(1).index();
        t.bigInteger('rate_bytes').notNullable();
        t.string('host', 255).notNullable();
        t.integer('pid').notNullable();
        // Epoch ms, refreshed while the request is live. A row whose lease
        // lapsed is abandoned whatever host or pid wrote it.
        t.bigInteger('heartbeat_at').notNullable().index();
      } else {
        t.string('request_id', 36).notNullable().index();
        t.text('object_key').notNullable();
        t.string('state', 20).notNullable().defaultTo('promoting');
        t.integer('pending').notNullable().defaultTo(1);
        t.string('reference_type', 20).nullable();
        t.integer('reference_id').nullable().index();
      }
    });
  }
};

exports.down = async function(knex) {
  // Destructive rollback is an operator operation, never runtime recovery.
  await knex.schema.dropTableIfExists('public_upload_objects');
  await knex.schema.dropTableIfExists('public_upload_requests');
  await knex.schema.dropTableIfExists('public_upload_lock');
};
