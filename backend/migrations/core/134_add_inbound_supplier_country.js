/**
 * Migration 134: supplier country on incoming invoices.
 *
 * `supplier_country` (ISO-3166 alpha-2) lets categorisation auto-default the
 * `tax_treatment`: a supplier whose country is in the install's VAT reclaim
 * list (Settings → Accounting → `accounting_vat_reclaim_countries`, typically
 * CH / LI) → `domestic` (input VAT reclaimable); otherwise →
 * `foreign_vat_non_reclaimable`. Closes the dangling VAT-consolidation slice
 * where the reclaim-countries setting was stored but never consumed.
 *
 * Additive + hasColumn-guarded.
 */
exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('inbound_documents'))) return;
  if (!(await knex.schema.hasColumn('inbound_documents', 'supplier_country'))) {
    await knex.schema.alterTable('inbound_documents', (t) => t.string('supplier_country', 2));
  }
};

exports.down = async function (knex) {
  if (!(await knex.schema.hasTable('inbound_documents'))) return;
  if (await knex.schema.hasColumn('inbound_documents', 'supplier_country')) {
    await knex.schema.alterTable('inbound_documents', (t) => t.dropColumn('supplier_country'));
  }
};
