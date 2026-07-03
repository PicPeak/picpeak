/**
 * Migration 148: mark when an admin has taken ownership of a (built-in) workflow.
 *
 * The boot seeder re-seeds a built-in on a SEED_VERSION bump and applies the new
 * default `enabled` state. Without a sentinel that would re-flip a flow the
 * admin had deliberately enabled/disabled. `admin_toggled_at` is stamped on any
 * admin enable/disable or edit; the seeder then leaves that flow alone. Nullable
 * → existing rows are treated as never-touched (seed defaults apply once).
 */
exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('workflows'))) return;
  if (!(await knex.schema.hasColumn('workflows', 'admin_toggled_at'))) {
    await knex.schema.alterTable('workflows', (t) => {
      t.timestamp('admin_toggled_at');
    });
  }
};

exports.down = async function (knex) {
  if (!(await knex.schema.hasTable('workflows'))) return;
  if (await knex.schema.hasColumn('workflows', 'admin_toggled_at')) {
    await knex.schema.alterTable('workflows', (t) => t.dropColumn('admin_toggled_at'));
  }
};
