/**
 * Migration 147: let a quote pick the booking workflow it runs on acceptance.
 *
 * Today quote.accepted fans out to every enabled flow with that trigger. This
 * column lets the admin choose ONE workflow per quote (e.g. "with contract" vs
 * "invoice only, no gallery"); emitQuoteEvent passes it as targetWorkflowId so
 * only the chosen flow runs. Plain nullable integer (not a hard FK) — the emit
 * re-checks the workflow exists + is enabled + matches the trigger at fire time,
 * so a deleted/disabled selection just runs nothing.
 */
exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('quotes'))) return;
  if (!(await knex.schema.hasColumn('quotes', 'booking_workflow_id'))) {
    await knex.schema.alterTable('quotes', (t) => {
      t.integer('booking_workflow_id');
    });
  }
};

exports.down = async function (knex) {
  if (!(await knex.schema.hasTable('quotes'))) return;
  if (await knex.schema.hasColumn('quotes', 'booking_workflow_id')) {
    await knex.schema.alterTable('quotes', (t) => t.dropColumn('booking_workflow_id'));
  }
};
