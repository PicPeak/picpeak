/**
 * Migration 179: shared run state for the maintenance sweeps (#1181).
 *
 * Both photo maintenance jobs — the dimension repair and the capture-date
 * backfill — tracked whether they were running in a module-level variable. On
 * a single-replica install that is correct. Behind a load balancer it is not:
 * the flag lives in one process, so a status poll routed to any other replica
 * answers `isRunning: false`, the UI re-enables the button, and the next POST
 * lands somewhere else and starts a second pass over the whole library. Both
 * replicas then read and parse every original off S3 or the NAS mount. The
 * `.whereNull(...)` guards on the writes mean nothing is corrupted — the cost
 * is the duplicated I/O, and an operator who cannot tell whether a job is
 * running.
 *
 * One row per job, claimed with a conditional UPDATE so the claim itself is
 * the mutual exclusion — the same UPDATE-with-guard shape backgroundProcessor
 * already uses to hand a photo to exactly one worker
 * (services/backgroundProcessor.js:110-116).
 *
 * heartbeat_at exists because a lock with no expiry is worse than no lock: a
 * replica that is OOM-killed mid-run would leave is_running = true forever and
 * no way to clear it short of editing the database. The runner touches it as
 * it goes, and a claim is allowed to take over a run whose heartbeat has gone
 * quiet. See services/maintenanceJobState.js for the read side, which reports
 * a stale run as not-running so the button comes back on its own.
 *
 * Rows are seeded here rather than created on demand so the claim is a plain
 * UPDATE with no insert race behind it.
 */

const JOBS = ['photo_dimension_repair', 'photo_capture_date_backfill'];

exports.up = async function (knex) {
  const exists = await knex.schema.hasTable('maintenance_jobs');
  if (!exists) {
    await knex.schema.createTable('maintenance_jobs', (t) => {
      // The job's identity, not a surrogate key: there is exactly one row per
      // job and every access is by name, so the name is the primary key.
      t.string('job_name', 64).primary();
      t.boolean('is_running').notNullable().defaultTo(false);
      t.timestamp('started_at').nullable();
      t.timestamp('heartbeat_at').nullable();
      t.timestamp('finished_at').nullable();
      // JSON as text: the shape differs per job (the backfill reports a third
      // counter the dimension repair has no equivalent for) and nothing
      // queries into it, so a json column would buy nothing and cost engine
      // differences between Postgres and SQLite.
      t.text('last_result').nullable();
      // Diagnostics only — which process is holding the claim.
      t.string('owner', 128).nullable();
      // The fencing token. Unique per claim, not per process: after a stale
      // takeover the old runner may still be alive and mid-loop, and it can
      // even be the same process that re-claimed. Every write it makes is
      // scoped to the token it was handed, so a superseded runner can neither
      // renew a claim it has lost nor release one it no longer owns.
      t.string('claim_token', 64).nullable();
    });
    console.log('179: created maintenance_jobs');
  }

  // Idempotent on re-run and safe against a table that already carries rows.
  for (const jobName of JOBS) {
    const row = await knex('maintenance_jobs').where({ job_name: jobName }).first();
    if (!row) {
      await knex('maintenance_jobs').insert({ job_name: jobName, is_running: false });
      console.log(`179: seeded job row ${jobName}`);
    }
  }
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('maintenance_jobs');
};
