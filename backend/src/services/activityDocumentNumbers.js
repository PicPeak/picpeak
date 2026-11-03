/**
 * Document numbers for the activity feed and the bell.
 *
 * Most CRM log calls store only the row id, while the labels print
 * {{invoiceNumber}} / {{quoteNumber}} / {{contractNumber}}. Resolving the
 * number when the feed is read also fixes rows that are already in the log.
 */
const { db } = require('../database/db');

// `invoice_reissued` and `storno_sent` carry the document their label means under another key.
const DOCUMENT_KINDS = [
  { idOf: (m) => m.newInvoiceId ?? m.invoiceId ?? m.stornoId, numberKey: 'invoiceNumber', table: 'invoices', column: 'invoice_number' },
  { idOf: (m) => m.quoteId, numberKey: 'quoteNumber', table: 'quotes', column: 'quote_number' },
  { idOf: (m) => m.contractId, numberKey: 'contractNumber', table: 'contracts', column: 'contract_number' },
];

/** Fills the missing number on each entry's `metadata`, in place. */
async function withDocumentNumbers(entries) {
  await Promise.all(DOCUMENT_KINDS.map(async ({ idOf, numberKey, table, column }) => {
    const pending = entries.filter(({ metadata }) => metadata && idOf(metadata) && !metadata[numberKey]);
    if (pending.length === 0) return;
    const ids = [...new Set(pending.map(({ metadata }) => idOf(metadata)))];
    const rows = await db(table).whereIn('id', ids).select('id', column);
    const numbers = new Map(rows.map((row) => [Number(row.id), row[column]]));
    for (const { metadata } of pending) {
      // A deleted document keeps its id, so the row never shows a raw {{placeholder}}.
      metadata[numberKey] = numbers.get(Number(idOf(metadata))) || `#${idOf(metadata)}`;
    }
  }));
  return entries;
}

module.exports = { withDocumentNumbers };
