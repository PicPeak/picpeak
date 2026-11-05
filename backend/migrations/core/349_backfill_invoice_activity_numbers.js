/**
 * Migration 349: add the invoice number to invoice activity rows that lack it.
 *
 * The admin notifications, the dashboard feed and the customer activity card
 * word these types as "Payment-check sent for invoice: {{invoiceNumber}}", but
 * only invoice_created and invoice_scheduled recorded `invoiceNumber`. Every
 * other type logged ids alone, so the line showed the raw placeholder. New
 * writes carry the number; this fills it in on the rows already on disk.
 *
 * The number is read from the invoice the row names: the Storno itself for
 * storno_sent, the cancelled original for invoice_reissued, `invoiceId` for the
 * rest. A row whose invoice is gone is left as it is. Re-running finds nothing
 * left to change.
 */
const BATCH = 500;

const ID_KEY = {
  invoice_sent: 'invoiceId',
  invoice_cancelled: 'invoiceId',
  invoice_cancelled_via_storno: 'invoiceId',
  invoice_reissued: 'originalInvoiceId',
  invoice_paid_admin_notified: 'invoiceId',
  invoice_payment_check_recorded: 'invoiceId',
  invoice_payment_check_sent: 'invoiceId',
  invoice_released_for_delivery: 'invoiceId',
  invoice_reminder_sent: 'invoiceId',
  storno_sent: 'stornoId',
};

function parseMetadata(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch (_) { return null; }
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('activity_logs'))) return;
  if (!(await knex.schema.hasColumn('activity_logs', 'metadata'))) return;
  if (!(await knex.schema.hasTable('invoices'))) return;

  let lastId = 0;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const rows = await knex('activity_logs')
      .where('id', '>', lastId)
      .whereIn('activity_type', Object.keys(ID_KEY))
      .orderBy('id', 'asc')
      .limit(BATCH)
      .select('id', 'activity_type', 'metadata');
    if (rows.length === 0) break;
    lastId = rows[rows.length - 1].id;

    const pending = [];
    for (const row of rows) {
      const meta = parseMetadata(row.metadata);
      if (!meta || typeof meta !== 'object' || meta.invoiceNumber) continue;
      const invoiceId = Number(meta[ID_KEY[row.activity_type]]);
      if (Number.isInteger(invoiceId) && invoiceId > 0) pending.push({ id: row.id, meta, invoiceId });
    }
    if (pending.length) {
      // eslint-disable-next-line no-await-in-loop
      const invoices = await knex('invoices')
        .whereIn('id', [...new Set(pending.map((p) => p.invoiceId))])
        .select('id', 'invoice_number');
      const numbers = new Map(invoices.map((inv) => [Number(inv.id), inv.invoice_number]));
      for (const { id, meta, invoiceId } of pending) {
        const invoiceNumber = numbers.get(invoiceId);
        if (!invoiceNumber) continue;
        // eslint-disable-next-line no-await-in-loop
        await knex('activity_logs').where({ id }).update({ metadata: JSON.stringify({ ...meta, invoiceNumber }) });
      }
    }
    if (rows.length < BATCH) break;
  }
};

// Nothing to undo: the added key is the number the row already pointed at.
exports.down = async function down() {};
