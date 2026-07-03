/**
 * Migration 145: crash-recovery fields for workflow runs.
 *
 * A run left in 'running'/'pending' by a crash has nothing to resume it (the
 * scheduler only wakes 'waiting' runs). Add a heartbeat (`updated_at`, stamped
 * on every step) so a recovery sweep can detect stale runs, plus an `attempts`
 * counter so a node that reliably crashes the process can't be recovered
 * forever (crash-loop backstop → marked failed after a cap).
 */
exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('workflow_runs'))) return;
  const hasUpdated = await knex.schema.hasColumn('workflow_runs', 'updated_at');
  const hasAttempts = await knex.schema.hasColumn('workflow_runs', 'attempts');
  await knex.schema.alterTable('workflow_runs', (t) => {
    if (!hasUpdated) t.timestamp('updated_at').defaultTo(knex.fn.now());
    if (!hasAttempts) t.integer('attempts').notNullable().defaultTo(0);
  });
  // Recovery sweep queries by (status, updated_at).
  if (!hasUpdated) {
    try { await knex.schema.alterTable('workflow_runs', (t) => t.index(['status', 'updated_at'], 'workflow_runs_recovery_index')); } catch (_) {}
  }
};

exports.down = async function (knex) {
  if (!(await knex.schema.hasTable('workflow_runs'))) return;
  try { await knex.schema.alterTable('workflow_runs', (t) => t.dropIndex(['status', 'updated_at'], 'workflow_runs_recovery_index')); } catch (_) {}
  if (await knex.schema.hasColumn('workflow_runs', 'updated_at')) {
    await knex.schema.alterTable('workflow_runs', (t) => t.dropColumn('updated_at'));
  }
  if (await knex.schema.hasColumn('workflow_runs', 'attempts')) {
    await knex.schema.alterTable('workflow_runs', (t) => t.dropColumn('attempts'));
  }
};
