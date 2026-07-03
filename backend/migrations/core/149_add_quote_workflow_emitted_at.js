/**
 * Migration 149: defer the quote.accepted/declined workflow emit past the
 * 15-min response window.
 *
 * A customer's accept/decline can be toggled for crm_quotes_accept_window_minutes
 * (default 15) before it locks. The booking workflow used to fire on the FIRST
 * click and immediately convert the quote (status -> 'converted'), which made the
 * quote un-declinable inside that window — defeating the grace period the public
 * page promises ("you can change your answer within 15 minutes").
 *
 * The fix moves the response emit to AFTER the window locks: the scheduler sweeps
 * locked-but-not-yet-emitted responses and fires quote.<final status> once. This
 * column is the idempotency marker so each response is emitted exactly once,
 * regardless of how many times the customer toggled inside the window.
 */
exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('quotes'))) return;
  if (!(await knex.schema.hasColumn('quotes', 'workflow_response_emitted_at'))) {
    await knex.schema.alterTable('quotes', (t) => {
      t.timestamp('workflow_response_emitted_at');
    });
  }
};

exports.down = async function (knex) {
  if (!(await knex.schema.hasTable('quotes'))) return;
  if (await knex.schema.hasColumn('quotes', 'workflow_response_emitted_at')) {
    await knex.schema.alterTable('quotes', (t) => t.dropColumn('workflow_response_emitted_at'));
  }
};
