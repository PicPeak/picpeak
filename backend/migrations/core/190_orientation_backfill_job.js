/**
 * Migration 190: a maintenance-job row for the orientation backfill (#1198).
 *
 * The backfill is its own job rather than a mode of the dimension repair. They
 * look similar — both walk photos and write width/height — but they are not
 * the same operation and must not share a lease:
 *
 * - the dimension repair FILLS rows that have none, and touches nothing else;
 * - this one RECOMPUTES rows that already have dimensions and, where the EXIF
 *   transform means the stored pixels have moved, invalidates the derived
 *   images and face data that were generated against the old orientation.
 *
 * Sharing one row would mean an operator filling in missing dimensions blocks
 * a colleague correcting a rotated library, and the two would report into the
 * same lastResult with different shapes.
 *
 * Seeded here for the same reason as 189: the claim is a plain conditional
 * UPDATE, and a row that has to be created on demand puts an insert race
 * behind the very thing that exists to prevent races.
 */

const JOB_NAME = 'photo_orientation_backfill';

exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('maintenance_jobs'))) {
    // 189 creates it. If it is missing the install has not reached that
    // migration yet, and 189 seeds its own rows when it runs.
    console.log('190: maintenance_jobs missing, skipping seed');
    return;
  }

  const existing = await knex('maintenance_jobs').where({ job_name: JOB_NAME }).first();
  if (!existing) {
    await knex('maintenance_jobs').insert({ job_name: JOB_NAME, is_running: false });
    console.log(`190: seeded job row ${JOB_NAME}`);
  }
};

exports.down = async function (knex) {
  if (await knex.schema.hasTable('maintenance_jobs')) {
    await knex('maintenance_jobs').where({ job_name: JOB_NAME }).del();
  }
};
