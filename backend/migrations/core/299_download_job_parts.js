'use strict';

/**
 * Migration 299: a download job whose archive is split into parts (issue
 * 1733, fork survey).
 *
 * NULL means the job is one archive, in `zip_path`, exactly as before. A job
 * that outgrew the part size stores its archives here instead, as JSON text:
 * [{ zip_path, size_bytes, photo_ids }], in part order. JSON text so SQLite
 * and PostgreSQL round-trip it the same way, like `photo_ids`.
 *
 * Additive and nullable; safe to re-run.
 */

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('download_jobs'))) return;
  if (await knex.schema.hasColumn('download_jobs', 'parts')) return;
  await knex.schema.alterTable('download_jobs', (table) => {
    table.text('parts').nullable();
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('download_jobs'))) return;
  if (!(await knex.schema.hasColumn('download_jobs', 'parts'))) return;
  await knex.schema.alterTable('download_jobs', (table) => {
    table.dropColumn('parts');
  });
};
