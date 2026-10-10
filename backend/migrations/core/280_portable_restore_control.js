'use strict';

// Runtime authority, not portable instance data. Nothing reads or writes
// these tables until a portable restore is first used on the instance.
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('portable_restore_control'))) {
    await knex.schema.createTable('portable_restore_control', table => {
      table.integer('id').primary();
      table.integer('format_version').notNullable().defaultTo(1);
      table.string('storage_id', 36).notNullable();
      table.string('state', 32).notNullable().defaultTo('open');
      table.integer('generation').notNullable().defaultTo(0);
      table.integer('revision').notNullable().defaultTo(0);
      table.string('epoch', 36);
      table.string('attempt_id', 36);
      table.string('owner_instance_id', 36);
      table.integer('operator_id');
      table.string('archive_path', 2048);
      table.text('options_json');
      table.text('worker_lease_json');
      table.string('progress_token_hash', 64);
      table.text('result_json');
      table.timestamp('updated_at').defaultTo(knex.fn.now());
    });
  }
  if (!(await knex.schema.hasTable('portable_restore_instances'))) {
    await knex.schema.createTable('portable_restore_instances', table => {
      table.string('instance_id', 36).primary();
      table.integer('generation').notNullable();
      table.string('storage_id', 36).notNullable();
      table.string('host_id', 64);
      table.string('boot_id', 36).notNullable();
      table.text('lease_json').notNullable();
      table.string('ack_epoch', 36);
      table.string('startup_ready_epoch', 36);
      table.timestamp('registered_at').defaultTo(knex.fn.now());
      // ISO string written by the runtime itself; decides whether a
      // registration whose kernel lease cannot be probed is still alive.
      table.string('heartbeat_at', 32);
    });
  } else if (!(await knex.schema.hasColumn('portable_restore_instances', 'heartbeat_at'))) {
    await knex.schema.alterTable('portable_restore_instances', table => table.string('heartbeat_at', 32));
  }
  if (!(await knex.schema.hasTable('portable_restore_commits'))) {
    await knex.schema.createTable('portable_restore_commits', table => {
      table.string('attempt_id', 36).primary();
      table.integer('format_version').notNullable().defaultTo(1);
      table.timestamp('committed_at').notNullable().defaultTo(knex.fn.now());
      table.string('local_plan_checksum', 64).notNullable();
      table.string('s3_namespace', 128);
      table.string('s3_revision', 36);
      table.string('s3_manifest_checksum', 64);
      table.string('options_digest', 64).notNullable();
    });
  }
};

exports.down = async function down(knex) {
  // Never drop a live fence or its evidence through ordinary rollback.
  if (await knex.schema.hasTable('portable_restore_control')) {
    const row = await knex('portable_restore_control').where({ id: 1 }).first();
    if (row && row.state !== 'open') throw new Error('Portable restore is fenced; control schema cannot be removed');
  }
  await knex.schema.dropTableIfExists('portable_restore_commits');
  await knex.schema.dropTableIfExists('portable_restore_instances');
  await knex.schema.dropTableIfExists('portable_restore_control');
};
