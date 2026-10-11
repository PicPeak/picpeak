'use strict';

/**
 * Migration 284: per-request override for the number of files a client may
 * select in one upload round (issue 1914).
 *
 * NULL means "use the global default" (app_settings
 * transfer_upload_max_files, 25 when unset), so every existing file request
 * keeps today's behaviour. Additive and nullable; safe to re-run.
 */

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('transfers'))) return;
  if (await knex.schema.hasColumn('transfers', 'max_files_per_upload')) return;
  await knex.schema.alterTable('transfers', (table) => {
    table.integer('max_files_per_upload').nullable();
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('transfers'))) return;
  if (!(await knex.schema.hasColumn('transfers', 'max_files_per_upload'))) return;
  await knex.schema.alterTable('transfers', (table) => {
    table.dropColumn('max_files_per_upload');
  });
};
