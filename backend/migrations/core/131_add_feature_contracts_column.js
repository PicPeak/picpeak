/**
 * Migration 131: per-customer `feature_contracts` override on customer_accounts.
 *
 * Contracts was master-only — every active customer saw the Contracts tab
 * whenever the global `contracts` feature flag was on. This adds a per-customer
 * toggle to match feature_calendar / feature_quotes / feature_bills /
 * feature_hours_logging, so an admin can hide Contracts for an individual
 * customer.
 *
 * PRESERVE-VISUALS: unlike the opt-in quotes/bills columns (default false),
 * contracts is currently opt-OUT (everyone has it), so the column defaults
 * TRUE. Adding a NOT NULL column with a default backfills existing rows to
 * true on both SQLite and Postgres, so no customer loses their Contracts tab
 * on upgrade. The effective resolver becomes
 * `contractsMaster && truthy(feature_contracts)`.
 *
 * Idempotent: guarded by hasColumn.
 */
exports.up = async function (knex) {
  const has = await knex.schema.hasColumn('customer_accounts', 'feature_contracts');
  if (!has) {
    await knex.schema.alterTable('customer_accounts', (table) => {
      table.boolean('feature_contracts').notNullable().defaultTo(true);
    });
  }
};

exports.down = async function (knex) {
  if (await knex.schema.hasColumn('customer_accounts', 'feature_contracts')) {
    await knex.schema.alterTable('customer_accounts', (table) => {
      table.dropColumn('feature_contracts');
    });
  }
};
