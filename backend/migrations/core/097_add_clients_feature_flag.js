/**
 * Migration: Add the `clients` top-level feature flag.
 *
 * Introduces a parent flag for the "Clients" sidebar section, which
 * groups customer accounts today and will host calendar / quotes /
 * bills / messaging in future PRs. The existing `customerPortal` flag
 * is unchanged and continues to gate the /customer/* surface plus the
 * Accounts sub-page; it now lives logically beneath `clients` in the
 * Features tab.
 *
 * Initial value: mirrors the install's current `customerPortal` value
 * so an admin who had the customer portal enabled keeps seeing the
 * Clients sidebar entry after upgrade, and an admin who had it off
 * doesn't suddenly see a new sidebar entry.
 *
 * Idempotent: re-runs are no-ops.
 */

exports.up = async function(knex) {
  if (!(await knex.schema.hasTable('feature_flags'))) return;

  const existing = await knex('feature_flags').where({ key: 'clients' }).first();
  if (existing) return;

  const portalRow = await knex('feature_flags').where({ key: 'customerPortal' }).first();
  let initialValue = false;
  if (portalRow) {
    const raw = portalRow.value;
    initialValue = raw === true || raw === 1 || raw === '1' || raw === 'true';
  }

  await knex('feature_flags').insert({ key: 'clients', value: initialValue });
};

exports.down = async function(knex) {
  if (!(await knex.schema.hasTable('feature_flags'))) return;
  await knex('feature_flags').where({ key: 'clients' }).del();
};
