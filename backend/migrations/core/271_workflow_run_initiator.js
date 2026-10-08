/**
 * Attribute manually fired workflow runs to the admin who created them.
 * Automatic runs remain entity-scoped and leave this column NULL.
 */
exports.up = async function (knex) {
  if ((await knex.schema.hasTable('workflow_runs'))
    && !(await knex.schema.hasColumn('workflow_runs', 'initiated_by_admin_id'))) {
    await knex.schema.alterTable('workflow_runs', (table) => {
      table.integer('initiated_by_admin_id').unsigned()
        .references('id').inTable('admin_users').onDelete('SET NULL');
      table.index(['initiated_by_admin_id'], 'workflow_runs_initiator_index');
    });
  }
};

exports.down = async function (knex) {
  if ((await knex.schema.hasTable('workflow_runs'))
    && (await knex.schema.hasColumn('workflow_runs', 'initiated_by_admin_id'))) {
    await knex.schema.alterTable('workflow_runs', (table) => {
      table.dropColumn('initiated_by_admin_id');
    });
  }
};
