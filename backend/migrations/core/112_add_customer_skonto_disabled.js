/**
 * Migration: per-customer Skonto opt-out.
 *
 * Background: invoices already carry a per-invoice `skonto_disabled`
 * flag (migration 126). For B2B customers who negotiated "no early-
 * payment discount" as a standing contract term, the admin had to tick
 * that toggle on every single invoice. This adds a customer-level flag
 * so the opt-out is set once and applies to all of that customer's
 * invoices. The resolver chain becomes:
 *   customer.skonto_disabled → invoice.skonto_disabled →
 *   invoice snapshot → source-quote snapshot → global default.
 *
 * Default false so existing customers keep inheriting whatever Skonto
 * the template / global default offers — no behaviour change on upgrade
 * (see migration-preserve-existing-state guidance).
 *
 * Idempotent: guarded by hasColumn so a re-run is a no-op.
 */

exports.up = async function(knex) {
  if (!(await knex.schema.hasTable('customer_accounts'))) return;
  if (await knex.schema.hasColumn('customer_accounts', 'skonto_disabled')) return;
  await knex.schema.alterTable('customer_accounts', (table) => {
    table.boolean('skonto_disabled').notNullable().defaultTo(false);
  });
};

exports.down = async function(knex) {
  if (!(await knex.schema.hasTable('customer_accounts'))) return;
  if (!(await knex.schema.hasColumn('customer_accounts', 'skonto_disabled'))) return;
  await knex.schema.alterTable('customer_accounts', (table) => {
    table.dropColumn('skonto_disabled');
  });
};
