/**
 * Migration 127: seed the `expenses` feature flag + the Accounting settings.
 *
 * - `expenses` feature flag (default OFF) — separate sub-toggle from
 *   `incomingInvoices` under the Accounting master.
 * - app_settings (setting_type='accounting'):
 *     accounting_km_rate_minor      default 70   (CHF 0.70 / km — VERIFY with
 *                                                 your Treuhänder, guideline only)
 *     accounting_per_diem_rate_minor default 0   (admin sets a daily rate)
 *     accounting_require_proof      default false (require a proof file on
 *                                                  internal expenses)
 *
 * Idempotent: inserts only when missing.
 */
const ACCOUNTING_SETTINGS = [
  { key: 'accounting_km_rate_minor', value: 70 },
  { key: 'accounting_per_diem_rate_minor', value: 0 },
  { key: 'accounting_require_proof', value: false },
];

exports.up = async function (knex) {
  if (await knex.schema.hasTable('feature_flags')) {
    const existing = await knex('feature_flags').where({ key: 'expenses' }).first();
    if (!existing) await knex('feature_flags').insert({ key: 'expenses', value: false });
  }

  if (await knex.schema.hasTable('app_settings')) {
    for (const s of ACCOUNTING_SETTINGS) {
      // eslint-disable-next-line no-await-in-loop
      const row = await knex('app_settings').where({ setting_key: s.key }).first();
      if (!row) {
        // NB: match the canonical app_settings seed pattern (migration 103) —
        // setting_key/value/type only, NO created_at/updated_at (the table's
        // migration schema has no such columns; including them errors).
        // eslint-disable-next-line no-await-in-loop
        await knex('app_settings').insert({
          setting_key: s.key,
          setting_value: JSON.stringify(s.value),
          setting_type: 'accounting',
        });
      }
    }
  }
};

exports.down = async function (knex) {
  if (await knex.schema.hasTable('feature_flags')) {
    await knex('feature_flags').where({ key: 'expenses' }).del();
  }
  if (await knex.schema.hasTable('app_settings')) {
    await knex('app_settings').whereIn('setting_key', ACCOUNTING_SETTINGS.map((s) => s.key)).del();
  }
};
