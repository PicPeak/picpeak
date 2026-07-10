/**
 * Migration 144: track the VAT portion of the Mahngebühr separately.
 *
 * The dunning rework keeps the fee on the invoice ROW as dunning state (gross
 * in late_fee_amount_minor) but renders it on a separate Mahnung document, NOT
 * on the immutable invoice. `late_fee_vat_minor` records the VAT component
 * (0 when VAT-exempt — DE/AT, or the org has no VAT) so the Mahnung can show
 * the breakdown and the tax report can later book the Mahngebühr VAT (CH).
 */
exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('invoices'))) return;
  if (!(await knex.schema.hasColumn('invoices', 'late_fee_vat_minor'))) {
    await knex.schema.alterTable('invoices', (t) => {
      t.bigInteger('late_fee_vat_minor').notNullable().defaultTo(0);
    });
  }
};

exports.down = async function (knex) {
  if (!(await knex.schema.hasTable('invoices'))) return;
  if (await knex.schema.hasColumn('invoices', 'late_fee_vat_minor')) {
    await knex.schema.alterTable('invoices', (t) => t.dropColumn('late_fee_vat_minor'));
  }
};
