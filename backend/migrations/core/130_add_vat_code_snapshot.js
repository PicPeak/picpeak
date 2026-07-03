/**
 * Migration: snapshot the chosen VAT code on quotes + invoices.
 *
 * The invoice/quote editors now pick an output VAT code from the central
 * vat_codes registry (Settings → Accounting) instead of free-typing a rate.
 * We snapshot the CODE STRING (e.g. "UN81") on the document at create time —
 * alongside the existing vat_rate — so the Treuhänder/accounting export emits
 * exactly the code the document was issued with, immutably. Editing or deleting
 * a vat_codes row later never changes a historical document's export code.
 *
 *   quotes.vat_code     nullable string (snapshot)
 *   invoices.vat_code   nullable string (snapshot)
 *
 * Legacy rows stay null; the export falls back to the rate→code map for those.
 * Idempotent: columns guarded.
 */

exports.up = async function (knex) {
  for (const tbl of ['quotes', 'invoices']) {
    if ((await knex.schema.hasTable(tbl)) && !(await knex.schema.hasColumn(tbl, 'vat_code'))) {
      await knex.schema.alterTable(tbl, (table) => {
        table.string('vat_code', 16);
      });
    }
  }
};

exports.down = async function (knex) {
  for (const tbl of ['quotes', 'invoices']) {
    if ((await knex.schema.hasTable(tbl)) && (await knex.schema.hasColumn(tbl, 'vat_code'))) {
      await knex.schema.alterTable(tbl, (table) => {
        table.dropColumn('vat_code');
      });
    }
  }
};
