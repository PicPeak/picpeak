/**
 * Migration 133: invoices (Bills) force-enable the Accounting master.
 *
 * Invoice VAT config (codes + label) and the default hourly rate now live under
 * Settings → Accounting, so an install with Bills enabled must have Accounting
 * available. `applyDependencyRules` enforces this on every flag READ/WRITE, but
 * the `requireFeatureFlag('accounting')` middleware reads the STORED row
 * directly — so existing installs that already have `bills=true, accounting=false`
 * would show the Accounting tab yet 403 its endpoints. This one-time correction
 * brings the stored value in line (forward fix, not a compensation: it encodes a
 * new dependency rule, it doesn't patch a buggy earlier migration).
 *
 * Idempotent: only flips accounting ON where Bills is on; never turns it off.
 */
function isOn(row) {
  return !!(row && (row.value === true || row.value === 1 || row.value === '1'));
}

exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('feature_flags'))) return;
  const bills = await knex('feature_flags').where({ key: 'bills' }).first();
  if (!isOn(bills)) return;

  const accounting = await knex('feature_flags').where({ key: 'accounting' }).first();
  if (!accounting) {
    await knex('feature_flags').insert({ key: 'accounting', value: true });
  } else if (!isOn(accounting)) {
    await knex('feature_flags').where({ key: 'accounting' }).update({ value: true });
  }
};

// No down — we can't know whether Accounting was independently wanted, and
// turning it back off could hide a section the admin now relies on.
exports.down = async function () {};
