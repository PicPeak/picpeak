/**
 * Migration: Flip the per-customer feature flag semantic to "opt-out".
 *
 * Original semantic (089): both global toggle AND per-customer flag had
 * to be ON for a customer to see Calendar/Quotes/Bills. Defaults: false.
 * Result: enabling a feature globally was a no-op until the admin clicked
 * through every customer detail page and toggled them on individually.
 *
 * New semantic (this migration): global toggle is the master; per-customer
 * flag defaults to TRUE and only acts as an override-to-hide. So:
 *
 *   - Global ON, per-customer default (true)  → visible
 *   - Global ON, per-customer set to false    → hidden for this customer
 *   - Global OFF, per-customer anything       → hidden (master wins)
 *
 * Migration steps:
 *   1. Update column defaults to true so new customer_accounts rows
 *      auto-opt-in.
 *   2. Flip every existing row's feature_* columns from false → true.
 *      Rows that were never touched (i.e. ALL of them at this stage in
 *      dev) end up with the new default. If a maintainer had already
 *      hand-toggled a customer to false to hide a feature, that's
 *      indistinguishable from the seeded default at this layer — so
 *      this migration deliberately overwrites. Acceptable because the
 *      original semantic only shipped for one image and nobody is
 *      relying on hand-set false values yet.
 *
 * Idempotent: re-running is a no-op (the UPDATE just confirms current
 * values).
 */

exports.up = async function(knex) {
  if (!(await knex.schema.hasTable('customer_accounts'))) return;

  // Step 1 — change defaults. Knex's .alter() rewrites the column;
  // we keep notNullable to match 089.
  await knex.schema.alterTable('customer_accounts', (table) => {
    table.boolean('feature_calendar').notNullable().defaultTo(true).alter();
    table.boolean('feature_quotes').notNullable().defaultTo(true).alter();
    table.boolean('feature_bills').notNullable().defaultTo(true).alter();
  });

  // Step 2 — flip existing rows so they pick up the new default. Without
  // this, customers created on the 089-shipped image stay invisible even
  // after the admin enables the feature globally.
  await knex('customer_accounts').update({
    feature_calendar: true,
    feature_quotes: true,
    feature_bills: true,
  });
};

exports.down = async function(knex) {
  if (!(await knex.schema.hasTable('customer_accounts'))) return;
  // Restore the 089 default of false. Don't bulk-update existing rows
  // back to false: that would silently hide features for customers the
  // admin had explicitly enabled post-090.
  await knex.schema.alterTable('customer_accounts', (table) => {
    table.boolean('feature_calendar').notNullable().defaultTo(false).alter();
    table.boolean('feature_quotes').notNullable().defaultTo(false).alter();
    table.boolean('feature_bills').notNullable().defaultTo(false).alter();
  });
};
