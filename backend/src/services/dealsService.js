/**
 * dealsService — read-only lineage queries grouped by `deal_uuid`.
 *
 * One UUID spans every quote, contract, and invoice that belongs to
 * the same customer engagement (migration 140). This module is the
 * single read surface for "show me everything tied to this deal" so
 * the frontend's DocumentLineageCard, internal audit traversals, and
 * any future deal-scoped reports query through one helper instead of
 * walking the legacy point-to-point FKs each on its own.
 *
 * Legacy FK columns (source_quote_id, source_contract_id,
 * cancels_invoice_id, replaces_invoice_id, cancellation_storno_id,
 * converted_contract_id, converted_event_id) are still populated on
 * write so audit logs and PDFs that show "Cancels invoice R-XXXX" or
 * "From quote Q-XXXX" continue to work — those carry SEMANTIC
 * relationships (which specific row this one replaces / cancels),
 * distinct from grouping. The grouping is what this service owns.
 *
 * The follow-up cleanup PR (already on the backlog) will drop the
 * legacy FK columns once deal_uuid is proven stable in production.
 */

const { db } = require('../database/db');

const MS_PER_DAY = 24 * 60 * 60 * 1000;
function deriveOffsetDays(invoice) {
  if (!invoice.installment_trigger) return 0;
  if (invoice.installment_trigger === 'after_delivery') return 0;
  const sched = invoice.scheduled_send_at
    ? new Date(invoice.scheduled_send_at) : null;
  if (!sched || Number.isNaN(sched.getTime())) return 0;
  const anchor = (invoice.installment_trigger === 'before_event'
    || invoice.installment_trigger === 'after_event')
    ? invoice.event_date
    : invoice.issue_date;
  if (!anchor) return 0;
  const anchorDate = new Date(anchor);
  if (Number.isNaN(anchorDate.getTime())) return 0;
  return Math.round((sched.getTime() - anchorDate.getTime()) / MS_PER_DAY);
}

/**
 * Fetch every document — quotes, contracts, invoices — sharing the
 * given `deal_uuid`. Each row carries enough state for the lineage
 * UI to render a clickable entry without a second round-trip:
 *
 *   - kind: 'quote' | 'contract' | 'invoice'
 *   - id, number (quote_number / contract_number / invoice_number)
 *   - status, currency, total_amount_minor
 *   - issue_date, created_at
 *   - kind-specific extras the renderer needs (e.g. invoice.kind for
 *     Storno detection)
 *
 * Returns an object keyed by kind:
 *
 *   { dealUuid, quotes: [...], contracts: [...], invoices: [...] }
 *
 * Sorted within each group by created_at ASC — earliest doc first.
 * Empty deals (no matches) return all three arrays as []; callers
 * should treat that as "no related docs", not an error.
 */
async function getDealDocuments(dealUuid) {
  if (!dealUuid) {
    return { dealUuid: null, quotes: [], contracts: [], invoices: [] };
  }

  const [quotes, contracts, invoices] = await Promise.all([
    db('quotes')
      .where({ deal_uuid: dealUuid })
      .orderBy('created_at', 'asc')
      .select(
        'id', 'quote_number', 'status', 'currency',
        'total_amount_minor', 'issue_date', 'valid_until',
        'event_name', 'event_date', 'created_at',
      ),
    db('contracts')
      .where({ deal_uuid: dealUuid })
      .orderBy('created_at', 'asc')
      .select(
        'id', 'contract_number', 'status', 'title',
        'issue_date', 'valid_until',
        'event_name', 'event_date', 'created_at',
      ),
    db('invoices')
      .where({ deal_uuid: dealUuid })
      .orderBy('created_at', 'asc')
      .select(
        'id', 'invoice_number', 'kind', 'status', 'currency',
        'total_amount_minor', 'paid_amount_minor',
        'issue_date', 'due_date',
        'event_name', 'event_date',
        // installment_trigger + scheduled_send_at let the lineage card
        // derive the per-slice trigger/offset_days needed to seed the
        // Edit Plan modal without a second round-trip.
        'installment_index', 'installment_total', 'installment_label',
        'installment_trigger', 'scheduled_send_at',
        'is_monthly_draft',
        'created_at',
      ),
  ]);

  return {
    dealUuid,
    quotes: quotes.map((q) => ({
      kind: 'quote',
      id: q.id,
      number: q.quote_number,
      status: q.status,
      currency: q.currency,
      totalAmountMinor: q.total_amount_minor,
      issueDate: q.issue_date,
      validUntil: q.valid_until,
      eventName: q.event_name,
      eventDate: q.event_date,
      createdAt: q.created_at,
    })),
    contracts: contracts.map((c) => ({
      kind: 'contract',
      id: c.id,
      number: c.contract_number,
      status: c.status,
      title: c.title,
      issueDate: c.issue_date,
      validUntil: c.valid_until,
      eventName: c.event_name,
      eventDate: c.event_date,
      createdAt: c.created_at,
    })),
    invoices: invoices.map((i) => ({
      kind: 'invoice',
      invoiceKind: i.kind, // 'invoice' | 'storno'
      id: i.id,
      number: i.invoice_number,
      status: i.status,
      currency: i.currency,
      totalAmountMinor: i.total_amount_minor,
      paidAmountMinor: i.paid_amount_minor,
      issueDate: i.issue_date,
      dueDate: i.due_date,
      eventName: i.event_name,
      eventDate: i.event_date,
      installmentIndex: i.installment_index,
      installmentTotal: i.installment_total,
      installmentLabel: i.installment_label,
      installmentTrigger: i.installment_trigger || null,
      // Approximate the original offset_days from the resolved
      // scheduled_send_at — exact round-trip would need a dedicated
      // column. The Edit Plan modal uses this as a seed; admin can
      // override. Anchor by trigger:
      //   - before_event / after_event → days from event_date
      //   - after_delivery             → 0 (waits indefinitely)
      //   - quote_accepted / fixed_date → days from issue_date
      installmentOffsetDays: deriveOffsetDays(i),
      isMonthlyDraft: Boolean(i.is_monthly_draft),
      createdAt: i.created_at,
    })),
  };
}

/**
 * Convenience: resolve a deal_uuid from any document identifier.
 * Useful for routes that receive an invoice/quote/contract id and
 * want the full lineage without making the client pass the UUID
 * explicitly.
 *
 * Returns the UUID string, or null if the row doesn't exist.
 */
async function resolveDealUuidFor(kind, id) {
  const table = ({ quote: 'quotes', contract: 'contracts', invoice: 'invoices' })[kind];
  if (!table) return null;
  const row = await db(table).where({ id }).first('deal_uuid');
  return row?.deal_uuid || null;
}

module.exports = {
  getDealDocuments,
  resolveDealUuidFor,
};
