/**
 * Migration: install-wide default hourly rate.
 *
 * Background: hour entries resolve a billing rate through
 *   entry.hourly_rate_minor_override → customer.hourly_rate_minor.
 * When a customer had neither set, saving an entry hard-failed with
 * HOURLY_RATE_REQUIRED — a confusing save-time error on the hours page.
 * This adds an install-wide fallback so a single global rate covers
 * every customer who hasn't been given an individual one. The chain
 * becomes:
 *   entry override → customer rate → business_profile default → (CTA).
 *
 * Stored in minor units (matches customer_accounts.hourly_rate_minor).
 * Nullable, default NULL: existing installs keep today's behaviour
 * (no implicit rate) until the admin sets one — no surprise rate gets
 * applied on upgrade (migration-preserve-existing-state guidance).
 *
 * Idempotent: guarded by hasColumn so a re-run is a no-op.
 */

exports.up = async function(knex) {
  if (!(await knex.schema.hasTable('business_profile'))) return;
  if (await knex.schema.hasColumn('business_profile', 'default_hourly_rate_minor')) return;
  await knex.schema.alterTable('business_profile', (table) => {
    table.bigInteger('default_hourly_rate_minor');
  });
};

exports.down = async function(knex) {
  if (!(await knex.schema.hasTable('business_profile'))) return;
  if (!(await knex.schema.hasColumn('business_profile', 'default_hourly_rate_minor'))) return;
  await knex.schema.alterTable('business_profile', (table) => {
    table.dropColumn('default_hourly_rate_minor');
  });
};
