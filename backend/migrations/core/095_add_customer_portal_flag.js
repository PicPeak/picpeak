/**
 * Migration 095: Add `customerPortal` to feature_flags.
 *
 * The customer portal (#354) is the foundation feature for the
 * customer-side UI surface — login, dashboard, profile, password reset,
 * and the admin Customers management page. Subordinate flags
 * (calendar, calendarBooking, quotes, bills, messaging) are already
 * present in the table from migration 088 and gate the customer-side
 * tabs that hang off the dashboard.
 *
 * Default seeding rule mirrors 088:
 *   - Existing install (events table has rows) → customerPortal = TRUE.
 *     The PR ships with the customer-portal foundation already wired,
 *     so an admin who upgrades shouldn't see admin sidebar entries
 *     vanish until they explicitly opt out from Settings → Features.
 *   - Fresh install (no events) → customerPortal = FALSE. Picpeak still
 *     ships as a focused gallery delivery tool by default; admins flip
 *     this on when they want recurring-customer logins.
 *
 * Idempotent: skips the insert when the row already exists. Re-running
 * is a no-op.
 */

exports.up = async function(knex) {
  if (!(await knex.schema.hasTable('feature_flags'))) return;

  const existing = await knex('feature_flags').where({ key: 'customerPortal' }).first();
  if (existing) return;

  // Same existing-vs-fresh detection 088 uses — count events. The flag
  // table is shared with 088's seeded keys; re-running detection keeps
  // each new feature flag in lockstep with the install state instead
  // of guessing per migration.
  const eventCountRow = await knex('events').count({ count: '*' }).first();
  const eventCount = parseInt(eventCountRow?.count || 0, 10);
  const isExistingInstall = eventCount > 0;

  await knex('feature_flags').insert({
    key: 'customerPortal',
    value: isExistingInstall,
  });
};

exports.down = async function(knex) {
  if (!(await knex.schema.hasTable('feature_flags'))) return;
  await knex('feature_flags').where({ key: 'customerPortal' }).del();
};
