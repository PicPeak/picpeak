'use strict';

/**
 * Migration 262: lift the stored rating rate limit to the proofing budget
 * (issue 1733, A3a).
 *
 * Migration 033 seeded app_settings.feedback_rate_limits with
 * `rating: { max: 100 }`, and getRateLimitSettings() spreads the stored
 * object over DEFAULT_RATE_LIMITS. Raising the default to 2000 in
 * feedbackRateLimit.js therefore reached fresh installs only; every migrated
 * install kept rejecting the 101st rating per hour, now one click per grid
 * tile away. Nothing in the app writes this setting, so a stored 100 is the
 * seed, not an operator's choice: it is lifted to the new default, any
 * other value is left alone.
 */

const LEGACY_MAX = 100;
const PROOFING_MAX = 2000;

function parse(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return null; }
}

async function rewriteRatingMax(knex, from, to) {
  if (!(await knex.schema.hasTable('app_settings'))) return;
  const row = await knex('app_settings').where({ setting_key: 'feedback_rate_limits' }).first();
  if (!row) return;
  const limits = parse(row.setting_value);
  if (!limits || !limits.rating || Number(limits.rating.max) !== from) return;
  limits.rating = { ...limits.rating, max: to };
  await knex('app_settings')
    .where({ id: row.id })
    .update({ setting_value: JSON.stringify(limits), updated_at: new Date().toISOString() });
}

exports.up = async function up(knex) {
  await rewriteRatingMax(knex, LEGACY_MAX, PROOFING_MAX);
};

exports.down = async function down(knex) {
  await rewriteRatingMax(knex, PROOFING_MAX, LEGACY_MAX);
};
