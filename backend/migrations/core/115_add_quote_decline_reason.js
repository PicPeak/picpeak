/**
 * Migration: admin decline-quote reason.
 *
 * Background: admins can now decline a quote on the customer's behalf
 * ("customer told us by phone they're not going ahead") instead of
 * waiting for the public response link. This stores an optional free-text
 * reason alongside the existing `declined_at` timestamp so the quote
 * detail page can show WHY it was declined.
 *
 * Nullable, no default — existing declined rows simply carry no reason,
 * which is exactly how customer-side declines already look. No behaviour
 * change on upgrade.
 *
 * Idempotent: guarded by hasColumn so a re-run is a no-op.
 */

exports.up = async function(knex) {
  if (!(await knex.schema.hasTable('quotes'))) return;
  if (await knex.schema.hasColumn('quotes', 'decline_reason')) return;
  await knex.schema.alterTable('quotes', (table) => {
    table.text('decline_reason');
  });
};

exports.down = async function(knex) {
  if (!(await knex.schema.hasTable('quotes'))) return;
  if (!(await knex.schema.hasColumn('quotes', 'decline_reason'))) return;
  await knex.schema.alterTable('quotes', (table) => {
    table.dropColumn('decline_reason');
  });
};
