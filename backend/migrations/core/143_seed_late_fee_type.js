/**
 * Migration 143: late-fee (Mahngebühr) type — flat amount OR percentage.
 *
 * Extends the existing flat `crm_invoices_late_fee_minor` with a type switch so
 * the dunning fee can be a percentage of the invoice gross instead of a fixed
 * amount. The fee is charged from the 2nd reminder onwards (the 1st is
 * fee-free), accumulating per fee-bearing reminder (2nd = 1×, 3rd = 2×).
 *
 * Seeds conservative defaults that PRESERVE current behaviour: type='flat'
 * (so the existing flat fee keeps applying) and percent=0. Idempotent —
 * only inserts keys that don't already exist, never clobbers an admin value.
 *
 * ⚠️ A late fee is only legally enforceable if the concrete amount is stated in
 * the AGB (Liechtenstein/Swiss law) — the admin UI surfaces this; verify with a
 * Treuhänder. See docs/crm-disclaimers / [[feedback_legal_financial_examples_only]].
 */
exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('app_settings'))) return;
  const seeds = [
    { setting_key: 'crm_invoices_late_fee_type', setting_value: JSON.stringify('flat'), setting_type: 'crm' },
    { setting_key: 'crm_invoices_late_fee_percent', setting_value: JSON.stringify(0), setting_type: 'crm' },
    // VAT on the late fee is jurisdiction-dependent (CH: yes; DE/AT: no), so it's
    // a toggle. Default OFF (preserve current no-VAT behaviour). No-op anyway
    // when the org doesn't charge VAT (business_profile.vat_rate_default = 0).
    { setting_key: 'crm_invoices_late_fee_vat_enabled', setting_value: JSON.stringify(false), setting_type: 'crm' },
  ];
  for (const s of seeds) {
    const exists = await knex('app_settings').where({ setting_key: s.setting_key }).first();
    if (!exists) await knex('app_settings').insert({ ...s, updated_at: new Date() });
  }
};

exports.down = async function (knex) {
  if (!(await knex.schema.hasTable('app_settings'))) return;
  await knex('app_settings')
    .whereIn('setting_key', ['crm_invoices_late_fee_type', 'crm_invoices_late_fee_percent', 'crm_invoices_late_fee_vat_enabled'])
    .del();
};
