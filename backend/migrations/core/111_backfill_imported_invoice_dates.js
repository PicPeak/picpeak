/**
 * Migration: backfill historical send/payment dates on already-imported
 * invoices.
 *
 * Background: the invoice-import endpoint (POST /admin/invoices/import)
 * used to stamp `sent_at` and `paid_at` with the moment of import
 * (`new Date()`) rather than the document's own historical dates. The
 * CRM dashboard's "Revenue · last 30 days" card keys on `paid_at`, so a
 * year-old paid invoice imported today wrongly counted toward the
 * rolling window. The route now anchors both timestamps to `issue_date`
 * (with an optional explicit `paidAt`); this migration brings the rows
 * imported under the old behaviour in line.
 *
 * Scope: rows with `imported_pdf_path` set — i.e. historical documents,
 * never invoices issued by picpeak itself. For those, no real payment
 * date was ever captured (the column held the import timestamp), so the
 * issue date is the best available anchor. Note: `paid_at`/`sent_at` are
 * operational timestamps, not part of the invoice's immutable legal
 * content — correcting an import-time bug on them doesn't alter the
 * issued document.
 *
 * Idempotent: re-runs just re-assign the same issue_date value.
 */

exports.up = async function(knex) {
  if (!(await knex.schema.hasTable('invoices'))) return;
  const cols = ['imported_pdf_path', 'issue_date', 'sent_at', 'paid_at'];
  for (const c of cols) {
    if (!(await knex.schema.hasColumn('invoices', c))) return;
  }

  // sent_at → issue_date for every imported row that has one.
  await knex('invoices')
    .whereNotNull('imported_pdf_path')
    .whereNotNull('sent_at')
    .update({ sent_at: knex.ref('issue_date') });

  // paid_at → issue_date for imported rows that recorded a payment.
  await knex('invoices')
    .whereNotNull('imported_pdf_path')
    .whereNotNull('paid_at')
    .update({ paid_at: knex.ref('issue_date') });
};

// Irreversible by design: the original import-time stamps were wrong
// data, and there's no record of them to restore.
exports.down = async function() {};
