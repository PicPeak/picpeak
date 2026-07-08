// Extracted verbatim from invoiceService.js — see ../invoiceService.js for the
// module-level overview. Do not add behavior here without updating the entry re-exports.

const { db, withRetry } = require('../../database/db');
const { ensureInt } = require('../../utils/numericHelpers');


// ---------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------

async function listInvoices({ filters = {}, sort = 'issue_desc', page = 1, pageSize = 25 } = {}) {
  return await withRetry(async () => {
    let query = db('invoices')
      .leftJoin('customer_accounts', 'invoices.customer_account_id', 'customer_accounts.id')
      // Surface the source contract's human contract_number (mirror of
      // the src_quote JOIN in getInvoiceById) so list rows + detail
      // page can render "From contract LBM-C-2026-0010" instead of
      // the bare DB id "#10". LEFT join — most invoices have no
      // source contract.
      .leftJoin('contracts as src_contract', 'invoices.source_contract_id', 'src_contract.id')
      .select(
        'invoices.*',
        'customer_accounts.email as customer_email',
        'customer_accounts.display_name as customer_display_name',
        'customer_accounts.first_name as customer_first_name',
        'customer_accounts.last_name as customer_last_name',
        // Same isPassive-source as getInvoiceById — surfaced so list
        // rows can render the Passive badge inline without an N+1
        // round-trip.
        'customer_accounts.password_hash as customer_password_hash',
        'customer_accounts.company_name as customer_company_name',
        'src_contract.contract_number as source_contract_number',
      );

    if (Array.isArray(filters.status) && filters.status.length > 0) {
      query = query.whereIn('invoices.status', filters.status);
    }
    if (filters.customerAccountId) {
      query = query.where('invoices.customer_account_id', filters.customerAccountId);
    }
    // Hide monthly drafts (migration 128) from the default list — they
    // live on the customer detail page's "Monthly billing queue" card.
    // Callers that explicitly want them (the customer-detail summary
    // fetch) pass `includeMonthlyDrafts: true`.
    if (!filters.includeMonthlyDrafts) {
      query = query.where(function () {
        this.where('invoices.is_monthly_draft', false)
          .orWhereNull('invoices.is_monthly_draft');
      });
    }
    if (filters.sourceQuoteId) {
      query = query.where('invoices.source_quote_id', filters.sourceQuoteId);
    }
    if (filters.unpaidOnly) {
      query = query.whereIn('invoices.status', ['scheduled', 'sent', 'overdue']);
    }
    if (filters.q && String(filters.q).trim()) {
      const term = `%${String(filters.q).trim()}%`;
      query = query.andWhere(function() {
        this.where('invoices.invoice_number', 'like', term)
          .orWhere('customer_accounts.email', 'like', term)
          .orWhere('customer_accounts.company_name', 'like', term);
      });
    }
    const countRow = await query.clone().clearSelect().clearOrder().count('invoices.id as total').first();
    const total = ensureInt(countRow?.total || 0);

    switch (sort) {
    // "Newest" / "Oldest" means newest/oldest by CREATION time, not
    // by issue_date. Issue_date is admin-controlled (used for tax
    // accruals, retro-dating, future-dating) so it can drift from
    // actual chronology — sorting by it makes a just-created invoice
    // disappear into the middle of the list whenever its issue_date
    // is set to something other than today. created_at always
    // reflects when the row landed in the DB. id is the tiebreaker
    // for rows that share a created_at second.
    case 'oldest':       query = query.orderBy('invoices.created_at', 'asc').orderBy('invoices.id', 'asc'); break;
    case 'issue_asc':    query = query.orderBy('invoices.issue_date', 'asc').orderBy('invoices.id', 'asc'); break;
    case 'issue_desc':   query = query.orderBy('invoices.issue_date', 'desc').orderBy('invoices.id', 'desc'); break;
    case 'due_asc':      query = query.orderBy('invoices.due_date', 'asc'); break;
    case 'due_desc':     query = query.orderBy('invoices.due_date', 'desc'); break;
    case 'value_asc':    query = query.orderBy('invoices.total_amount_minor', 'asc'); break;
    case 'value_desc':   query = query.orderBy('invoices.total_amount_minor', 'desc'); break;
    case 'customer_asc':
      query = query
        .orderByRaw('COALESCE(customer_accounts.company_name, customer_accounts.last_name, customer_accounts.email) asc')
        .orderBy('invoices.id', 'desc');
      break;
    case 'customer_desc':
      query = query
        .orderByRaw('COALESCE(customer_accounts.company_name, customer_accounts.last_name, customer_accounts.email) desc')
        .orderBy('invoices.id', 'desc');
      break;
    case 'newest':
    default:
      query = query.orderBy('invoices.created_at', 'desc').orderBy('invoices.id', 'desc');
      break;
    }

    const offset = Math.max(0, (page - 1) * pageSize);
    query = query.offset(offset).limit(pageSize);
    const rows = await query;
    return { rows, total, page, pageSize };
  });
}

async function getInvoiceById(id) {
  return await withRetry(async () => {
    // LEFT JOIN customer_accounts so transformInvoice has populated
    // customer_email / company etc. — mirrors getQuoteById.
    const invoice = await db('invoices')
      .leftJoin('customer_accounts', 'invoices.customer_account_id', 'customer_accounts.id')
      // Join the source quote so the detail view can display its
      // human-readable number ("LBM-Q-2026-0006") instead of just
      // the numeric id ("#6"). LEFT join — most invoices come from
      // a quote conversion but standalone invoices don't have one.
      .leftJoin('quotes as src_quote', 'invoices.source_quote_id', 'src_quote.id')
      // Migration 130 lineage: source contract's human contract_number
      // so the detail view shows "From contract LBM-C-2026-0010"
      // instead of "#10". Same LEFT-join shape as src_quote.
      .leftJoin('contracts as src_contract', 'invoices.source_contract_id', 'src_contract.id')
      // Self-joins for Storno lineage so the detail view can render
      // "Cancelled by Stornorechnung S-XXXX" / "This Stornorechnung
      // cancels invoice R-XXXX" using the human invoice_number rather
      // than the bare DB row id. Same pattern as source_quote_number.
      .leftJoin('invoices as cancels_inv', 'invoices.cancels_invoice_id', 'cancels_inv.id')
      .leftJoin('invoices as cancellation_storno', 'invoices.cancellation_storno_id', 'cancellation_storno.id')
      .where('invoices.id', id)
      .select(
        'invoices.*',
        'customer_accounts.email as customer_email',
        'customer_accounts.display_name as customer_display_name',
        'customer_accounts.first_name as customer_first_name',
        'customer_accounts.last_name as customer_last_name',
        'customer_accounts.company_name as customer_company_name',
        // Surfaced so the route's transformInvoice can compute the
        // customer.isPassive flag (passwordHash == null). The hash
        // itself never leaves the API — transformInvoice drops it
        // and only exposes the boolean.
        'customer_accounts.password_hash as customer_password_hash',
        'src_quote.quote_number as source_quote_number',
        'src_contract.contract_number as source_contract_number',
        'cancels_inv.invoice_number as cancels_invoice_number',
        'cancellation_storno.invoice_number as cancellation_storno_number',
      )
      .first();
    if (!invoice) return null;
    // Self-join so each row also carries `parent_position` (the position
    // of its parent line item, when it's a sub-item). The editor needs
    // position-based references to rebuild the hierarchy in the UI;
    // parent_line_item_id is the DB-level relationship but isn't
    // stable in the payload the editor sends back. Migration 119.
    const lineItems = await db('invoice_line_items as li')
      .leftJoin('invoice_line_items as parent', 'parent.id', 'li.parent_line_item_id')
      .where('li.invoice_id', id)
      .orderBy('li.position', 'asc')
      .select('li.*', 'parent.position as parent_position');
    const payments = await db('invoice_payment_log').where({ invoice_id: id }).orderBy('paid_at', 'asc');
    return { invoice, lineItems, payments };
  });
}
module.exports = {
  listInvoices,
  getInvoiceById,
};
