'use strict';

/**
 * Migration 338: content-hash backfill (issue 2194).
 *
 * Migration 290 hashed uploads only. Watch-folder, external-media and S3
 * imports, and every row from before 290, carry no hash and never match a
 * duplicate. Filling them reads every original once, which on a NAS or S3
 * library is real I/O and egress, so it is an admin-started maintenance job
 * that can be paused, never something a migration or the boot does.
 *
 *   photos.content_sha256_error   Why the backfill could not read this
 *                                 photo's original. A run passes such a row
 *                                 over instead of trying it again on every
 *                                 start; "retry unreadable" clears it, and so
 *                                 does a refresh of the file.
 *   maintenance_jobs.pause_requested
 *                                 Set by the pause button, read by the runner
 *                                 between files. In the database, not in the
 *                                 process: the runner may be on another
 *                                 replica than the request.
 *
 * The job's maintenance_jobs row is seeded for the reason 190 gives: the
 * claim is a conditional UPDATE and must find a row.
 *
 * Additive, nullable, hasColumn-guarded and safe to re-run.
 */

const JOB = 'photo_content_hash_backfill';

exports.up = async function up(knex) {
  if (await knex.schema.hasTable('photos') && !(await knex.schema.hasColumn('photos', 'content_sha256_error'))) {
    await knex.schema.alterTable('photos', (table) => {
      table.string('content_sha256_error', 255).nullable();
    });
  }

  if (await knex.schema.hasTable('maintenance_jobs')) {
    if (!(await knex.schema.hasColumn('maintenance_jobs', 'pause_requested'))) {
      await knex.schema.alterTable('maintenance_jobs', (table) => {
        table.boolean('pause_requested').notNullable().defaultTo(false);
      });
    }
    const existing = await knex('maintenance_jobs').where({ job_name: JOB }).first();
    if (!existing) {
      await knex('maintenance_jobs').insert({ job_name: JOB, is_running: false });
    }
  }
};

exports.down = async function down(knex) {
  if (await knex.schema.hasTable('maintenance_jobs')) {
    await knex('maintenance_jobs').where({ job_name: JOB }).del();
    if (await knex.schema.hasColumn('maintenance_jobs', 'pause_requested')) {
      await knex.schema.alterTable('maintenance_jobs', (table) => {
        table.dropColumn('pause_requested');
      });
    }
  }
  if (await knex.schema.hasTable('photos') && await knex.schema.hasColumn('photos', 'content_sha256_error')) {
    await knex.schema.alterTable('photos', (table) => {
      table.dropColumn('content_sha256_error');
    });
  }
};
