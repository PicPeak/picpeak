/**
 * Migration: back-fix the backup_runs indexes that migration 035 tried to
 * create on the nonexistent `created_at` column (#484).
 *
 * On Postgres, 035's `CREATE INDEX ... ON backup_runs(created_at, ...)`
 * statements raised `column "created_at" does not exist`, which was caught
 * silently by the wrapping try/catch — so the migration "succeeded" but the
 * indexes never got created. Fresh installs saw the ERROR in the postgres
 * log; existing installs simply ran without those indexes.
 *
 * 035 has now been corrected to use `started_at` (the column that does
 * exist on backup_runs and carries the same chronological semantics).
 * This migration creates the same indexes idempotently for any deployment
 * whose 035 silently failed — no-op on fresh installs because 035 already
 * built them.
 *
 * SQLite: partial indexes (`WHERE …`) work but cross-table semantics differ
 * slightly from Postgres; we still emit them because the only consumer is
 * the backup-history query in `backupService` and it issues identical SQL
 * across both backends.
 */

exports.up = async function(knex) {
  if (!(await knex.schema.hasTable('backup_runs'))) return;
  if (!(await knex.schema.hasColumn('backup_runs', 'started_at'))) return;

  // Plain composite index — matches the corrected statement in 035.
  await knex.raw(
    'CREATE INDEX IF NOT EXISTS idx_backup_runs_started_mode ON backup_runs(started_at, backup_mode)'
  );

  // Partial indexes only get created if backup_mode exists (035 added it).
  if (!(await knex.schema.hasColumn('backup_runs', 'backup_mode'))) return;

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_backup_runs_recent_successful
    ON backup_runs(started_at DESC)
    WHERE status = 'completed' AND backup_mode = 'full'
  `);

  if (await knex.schema.hasColumn('backup_runs', 'parent_backup_id')) {
    await knex.raw(`
      CREATE INDEX IF NOT EXISTS idx_backup_runs_incremental_chain
      ON backup_runs(parent_backup_id, started_at)
      WHERE backup_mode = 'incremental'
    `);
  }
};

exports.down = async function(knex) {
  if (!(await knex.schema.hasTable('backup_runs'))) return;
  await knex.raw('DROP INDEX IF EXISTS idx_backup_runs_started_mode');
  await knex.raw('DROP INDEX IF EXISTS idx_backup_runs_recent_successful');
  await knex.raw('DROP INDEX IF EXISTS idx_backup_runs_incremental_chain');
};
