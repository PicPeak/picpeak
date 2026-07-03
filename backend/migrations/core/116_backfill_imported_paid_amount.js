/**
 * Migration: backfill paid_amount_minor for imported PAID invoices that
 * stored 0.
 *
 * Background: the historical-invoice import only sent paidAmountMinor when
 * the admin separately filled the "paid amount" field. Left blank (easy to
 * miss — the total was already entered), it stored paid_amount_minor = 0
 * even with status='paid'. The dashboard revenue windows sum
 * paid_amount_minor (not total), so those paid imports contributed NOTHING
 * to revenue. The import route now defaults a blank paid amount to the
 * total; this fixes the rows already created before that change.
 *
 * Scope: imported (imported_pdf_path set) + status='paid' + paid_amount_minor
 * 0/null → set paid_amount_minor = total_amount_minor (fully paid). Operational
 * payment field, not immutable legal content (same reasoning as migration 111).
 *
 * Idempotent: re-running sets the same value; rows already > 0 are untouched.
 */

exports.up = async function(knex) {
  if (!(await knex.schema.hasTable('invoices'))) return;
  if (!(await knex.schema.hasColumn('invoices', 'imported_pdf_path'))) return;
  if (!(await knex.schema.hasColumn('invoices', 'paid_amount_minor'))) return;

  await knex('invoices')
    .whereNotNull('imported_pdf_path')
    .where('status', 'paid')
    .andWhere(function() {
      this.where('paid_amount_minor', 0).orWhereNull('paid_amount_minor');
    })
    .update({ paid_amount_minor: knex.raw('total_amount_minor') });
};

exports.down = async function() {
  // Irreversible data backfill — we can't tell which rows we changed apart
  // from legitimately-full payments. No-op.
};
