/**
 * Migration: seed the `projects` feature flag (default OFF).
 *
 * Gates the admin-only Project Overview cockpit + the "book to project" hours
 * control. Off by default so existing installs don't suddenly surface a new
 * top-level CRM area — the admin opts in under Settings → Features, exactly
 * like bills/quotes/contracts/hours.
 *
 * Idempotent: inserts only when the row is missing (migration 088 already
 * seeded the original flag set on fresh installs and won't re-run).
 */

exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('feature_flags'))) return;
  const existing = await knex('feature_flags').where({ key: 'projects' }).first();
  if (!existing) {
    await knex('feature_flags').insert({ key: 'projects', value: false });
  }
};

exports.down = async function (knex) {
  if (!(await knex.schema.hasTable('feature_flags'))) return;
  await knex('feature_flags').where({ key: 'projects' }).del();
};
