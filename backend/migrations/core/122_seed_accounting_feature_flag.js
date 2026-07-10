/**
 * Migration 122: seed the Accounting feature flags.
 *
 *   - `accounting`       : top-level MASTER for the Accounting section
 *                          (separate from CRM). Default OFF — EXCEPT on
 *                          installs that already had the Tax report
 *                          (`taxReport`) enabled: the Tax export relocated
 *                          permanently into Accounting, so we auto-enable the
 *                          master there to preserve the existing menu (per the
 *                          "migrations preserve visual state" rule). Otherwise
 *                          admins opt in under Settings → Features.
 *   - `incomingInvoices` : Accounting sub-feature (supplier-invoice capture +
 *                          expenses + re-bill). Always default OFF (new).
 *
 * Idempotent: each row is inserted only when missing. 107_crm_consolidated
 * already shipped its flag set and won't re-run.
 */
exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('feature_flags'))) return;

  const existingAccounting = await knex('feature_flags').where({ key: 'accounting' }).first();
  if (!existingAccounting) {
    // Preserve visuals: if Tax was already on, light up the Accounting
    // master so the relocated Tax export doesn't vanish on upgrade.
    const taxRow = await knex('feature_flags').where({ key: 'taxReport' }).first();
    const taxOn = !!(taxRow && (taxRow.value === true || taxRow.value === 1 || taxRow.value === '1'));
    await knex('feature_flags').insert({ key: 'accounting', value: taxOn });
  }

  const existingIncoming = await knex('feature_flags').where({ key: 'incomingInvoices' }).first();
  if (!existingIncoming) {
    await knex('feature_flags').insert({ key: 'incomingInvoices', value: false });
  }
};

exports.down = async function (knex) {
  if (!(await knex.schema.hasTable('feature_flags'))) return;
  await knex('feature_flags').whereIn('key', ['accounting', 'incomingInvoices']).del();
};
