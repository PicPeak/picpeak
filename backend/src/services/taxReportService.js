/**
 * taxReportService — period-scoped revenue listing for tax filing.
 *
 * Pulls every revenue-relevant invoice in [from, to] (accrual basis,
 * keyed on `issue_date`) and returns rows + totals broken down by
 * VAT rate. Cancelled invoices stay in the row list (DE/CH/AT audit
 * trail requires a gap-free invoice-number sequence) but are excluded
 * from the totals math.
 *
 * Late fees: the user opted to include them in the totals. We split
 * each invoice's `late_fee_amount_minor` proportionally using the
 * invoice's own VAT rate:
 *   lateFeeNet = round(late_fee_amount_minor / (1 + vat_rate/100))
 *   lateFeeVat = late_fee_amount_minor − lateFeeNet
 * and add those onto the stored `net_amount_minor` / `vat_amount_minor`
 * before reporting. Invoices without a late fee → math collapses to
 * the stored values.
 *
 * Returned shape (see getTaxReport):
 *   {
 *     rows:               [{ id, invoiceNumber, issueDate, currency,
 *                            vatRate, customerLabel, eventName,
 *                            netMinor, vatMinor, totalMinor,
 *                            isCancelled, replacedByInvoiceNumber }, …],
 *     totalsByVatRate:    [{ vatRate, netMinor, vatMinor, totalMinor }, …],
 *     grandTotalNet:      Number (minor units),
 *     grandTotalVat:      Number (minor units),
 *     grandTotal:         Number (minor units),
 *     cancelledCount:     Number,
 *     currency:           String,
 *     period:             { from: 'YYYY-MM-DD', to: 'YYYY-MM-DD' },
 *   }
 *
 * Counterpart renderers (renderTaxReportPdf / renderTaxReportCsv)
 * land in commit 3 alongside the routes — keeping the service pure
 * data-shaping for this commit.
 */

const { db, withRetry } = require('../database/db');
const pdfService = require('./pdfService');
const businessProfileService = require('./businessProfileService');
const { getAppSetting } = require('../utils/appSettings');
const { t } = require('./pdf-i18n');
const { formatMinor, formatDate } = pdfService._internal;

// Rows we WANT to surface in the tax report. `cancelled` is included
// for audit visibility; the totals math filters it out separately.
const REPORTABLE_STATUSES = ['sent', 'paid', 'overdue', 'pending_delivery', 'cancelled'];

// D.2 — `ensureInt` consolidated into utils/numericHelpers.
const { ensureInt } = require('../utils/numericHelpers');
const { neutralizeSpreadsheetFormula } = require('../utils/spreadsheetSafe');
const logger = require('../utils/logger');

function ensureRate(v) {
  if (v === null || v === undefined || v === '') return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Compose the customer label we show in the table. Prefers company
 * name (most invoices in this workflow are B2B), falls back to
 * "First Last", then display_name, then email. Mirrors how the bills
 * list page picks a label so the two views feel consistent.
 */
function buildCustomerLabel(row) {
  if (row.customer_company_name && String(row.customer_company_name).trim()) {
    return String(row.customer_company_name).trim();
  }
  const first = row.customer_first_name ? String(row.customer_first_name).trim() : '';
  const last  = row.customer_last_name  ? String(row.customer_last_name).trim()  : '';
  const fullName = `${first} ${last}`.trim();
  if (fullName) return fullName;
  if (row.customer_display_name) return String(row.customer_display_name).trim();
  if (row.customer_email) return String(row.customer_email).trim();
  return '';
}

/**
 * Split a late-fee gross amount into (net, vat) components using the
 * invoice's own VAT rate. Rounding direction matches how we render
 * money throughout the system: half-to-even on the net portion,
 * remainder lands in VAT so net + vat = grossInput exactly.
 *
 *   grossUpLateFee(2500, 7.7) → { net: 2321, vat: 179 }   // 25.00 → 23.21 + 1.79
 *   grossUpLateFee(2500, 0)   → { net: 2500, vat: 0 }     // no VAT, fee is pure net
 */
function grossUpLateFee(grossMinor, vatRatePercent) {
  const fee = ensureInt(grossMinor);
  if (fee <= 0) return { net: 0, vat: 0 };
  const rate = ensureRate(vatRatePercent);
  if (rate <= 0) return { net: fee, vat: 0 };
  const net = Math.round(fee / (1 + rate / 100));
  const vat = fee - net;
  return { net, vat };
}

/**
 * Apply the late-fee gross-up to a raw DB row and return the values
 * we'll show + sum in the report. Net + VAT are the stored amounts
 * PLUS the late-fee components; total stays at `total_amount_minor`
 * (already includes the late fee).
 */
function computeReportedAmounts(row) {
  const baseNet = ensureInt(row.net_amount_minor);
  const baseVat = ensureInt(row.vat_amount_minor);
  const total   = ensureInt(row.total_amount_minor);
  const { net: lateNet, vat: lateVat } = grossUpLateFee(row.late_fee_amount_minor, row.vat_rate);
  return {
    netMinor:   baseNet + lateNet,
    vatMinor:   baseVat + lateVat,
    totalMinor: total,
  };
}

/**
 * Resolve which replacement invoice (if any) was issued for each
 * cancelled row. Used for the "Bezug → R-2026-0043" badge in the UI
 * and PDF. Single batched query, no N+1.
 */
async function loadReplacementsMap(cancelledIds) {
  if (!cancelledIds.length) return new Map();
  const successors = await db('invoices')
    .whereIn('replaces_invoice_id', cancelledIds)
    .select('replaces_invoice_id', 'invoice_number');
  const map = new Map();
  for (const s of successors) {
    map.set(s.replaces_invoice_id, s.invoice_number);
  }
  return map;
}

/**
 * Aggregate Skonto state per invoice from `invoice_payment_log`
 * (migration 126). Returns Map<invoice_id, { applied, amountMinor }>.
 * An invoice is considered Skonto-applied if ANY of its payment-log
 * rows carries the flag — admins occasionally split the discounted
 * total across multiple rows (e.g. retainer + final).
 *
 * Single batched query, no N+1. Empty map when the input list is
 * empty so the main path can skip the lookup entirely on empty
 * periods.
 */
async function loadSkontoMap(invoiceIds) {
  if (!invoiceIds.length) return new Map();
  const rows = await db('invoice_payment_log')
    .whereIn('invoice_id', invoiceIds)
    .select('invoice_id', 'skonto_applied', 'skonto_amount_minor');
  const map = new Map();
  for (const r of rows) {
    const flag = r.skonto_applied === true || r.skonto_applied === 1;
    const amt = Number(r.skonto_amount_minor || 0);
    const cur = map.get(r.invoice_id) || { applied: false, amountMinor: 0 };
    if (flag) cur.applied = true;
    cur.amountMinor += amt;
    map.set(r.invoice_id, cur);
  }
  return map;
}

/**
 * Cost side of the Milchbüchlein view (Einnahmen-Ausgaben-Rechnung).
 *
 * Aggregates the two cost entities the Accounting feature tracks, both
 * keyed on an accrual date inside [from, to] and scoped to `cur`:
 *
 *   1. incoming invoices (`inbound_documents`) — external supplier
 *      payables. Accrual date = invoice_date, falling back to created_at.
 *      Excludes declined + duplicate rows (not real costs).
 *   2. expenses (`expenses`) — internal own-costs (mileage / per-diem /
 *      amount). Accrual date = created_at (no separate invoice date on
 *      internal expenses). Excludes declined status + duplikat/abgelehnt
 *      disposition.
 *
 * Both book to an event OR the company (event_id NULL = company); the
 * report surfaces every cost regardless so the total is the full
 * outflow for the period. Re-billed costs intentionally stay IN — the
 * matching re-bill revenue is already counted on the income side, so
 * keeping both sides nets correctly (a pure pass-through cancels out).
 *
 * Currency: the report is single-currency. Incoming invoices match on
 * their own `currency`. Internal expenses are stored in CHF base
 * (chf_amount_minor) plus an optional original-currency amount — for a
 * CHF report we use the CHF base; for a foreign-currency report we match
 * the expense's original_currency and use original_amount_minor.
 *
 * Tables are schema-guarded: a DB without the accounting migrations
 * yields an empty cost side rather than throwing.
 *
 * Returns { rows, totalNet, totalVat, totalGross } in minor units.
 */
function normMinor(v) { return ensureInt(v); }

async function loadCosts({ from, to, cur }) {
  const rows = [];
  let totalNet = 0;
  let totalVat = 0;
  let totalGross = 0;
  // Input VAT is only reclaimable for domestic-style treatments; foreign
  // non-reclaimable VAT is a cost, not a deduction. Feeds the report's
  // VAT-payable (output − reclaimable input).
  let reclaimableVat = 0;
  // Inclusive upper bound covering the whole `to` day. Plain range comparison
  // (no SQL date() function) so it's valid on both Postgres and SQLite — the
  // mocked unit tests can't catch a PG-only function error. invoice_date is a
  // DATE, created_at a TIMESTAMP; both compare correctly against ISO literals.
  const toEnd = `${to} 23:59:59.999`;

  const push = (r) => {
    rows.push(r);
    totalNet += r.netMinor;
    totalVat += r.vatMinor;
    totalGross += r.totalMinor;
    if (r.taxTreatment !== 'foreign_vat_non_reclaimable') reclaimableVat += r.vatMinor;
  };

  // 1) Incoming invoices (external supplier payables).
  if (await db.schema.hasTable('inbound_documents')) {
    const inbound = await db('inbound_documents')
      .leftJoin('events', 'inbound_documents.event_id', 'events.id')
      // Date in range: invoice_date (a DATE) when set, else created_at (a
      // TIMESTAMP). Split instead of COALESCE so we never compare mixed
      // date/timestamp types (a Postgres error the mocked tests can't see).
      .where((qb) => {
        qb.whereBetween('inbound_documents.invoice_date', [from, to])
          .orWhere((q2) => q2.whereNull('inbound_documents.invoice_date')
            .andWhere('inbound_documents.created_at', '>=', from)
            .andWhere('inbound_documents.created_at', '<=', toEnd));
      })
      // Currency match, but INCLUDE rows with no currency set — captured
      // invoices (email/upload) often have a null currency; treat them as the
      // report currency rather than silently dropping them from the cost side.
      .where((qb) => { qb.where('inbound_documents.currency', cur).orWhereNull('inbound_documents.currency'); })
      .whereNotIn('inbound_documents.status', ['declined', 'duplicate'])
      .orderBy('inbound_documents.created_at', 'asc')
      .select(
        'inbound_documents.id',
        'inbound_documents.invoice_date',
        'inbound_documents.created_at',
        'inbound_documents.supplier_name',
        // inbound_documents has no free-text `description` column (that lives on
        // `expenses`); use the supplier invoice number as the row descriptor so
        // the cost side aligns with the expense rows without a phantom column.
        'inbound_documents.invoice_number',
        'inbound_documents.disposition',
        'inbound_documents.tax_treatment',
        'inbound_documents.status',
        'inbound_documents.event_id',
        'inbound_documents.net_amount_minor',
        'inbound_documents.vat_amount_minor',
        'inbound_documents.total_amount_minor',
        'events.event_name as event_name',
      );
    for (const r of inbound) {
      const vat = normMinor(r.vat_amount_minor);
      let total = normMinor(r.total_amount_minor);
      let net = normMinor(r.net_amount_minor);
      if (!total && (net || vat)) total = net + vat;
      if (!net && total) net = total - vat;
      push({
        id: r.id,
        source: 'incoming',
        date: r.invoice_date || r.created_at,
        supplierLabel: (r.supplier_name && String(r.supplier_name).trim()) || '',
        description: r.invoice_number || '',
        eventName: r.event_id ? (r.event_name || '') : '',
        disposition: r.disposition || '',
        taxTreatment: r.tax_treatment || 'domestic',
        status: r.status || '',
        netMinor: net,
        vatMinor: vat,
        totalMinor: total,
      });
    }
  }

  // 2) Internal expenses (own-costs).
  if (await db.schema.hasTable('expenses')) {
    const isChf = cur === 'CHF';
    const q = db('expenses')
      .leftJoin('events', 'expenses.event_id', 'events.id')
      .whereRaw('expenses.created_at >= ? AND expenses.created_at <= ?', [from, toEnd])
      .whereNot('expenses.status', 'declined')
      .whereNotIn('expenses.disposition', ['duplikat', 'abgelehnt']);
    // CHF report includes every expense (all carry a CHF base). A
    // foreign-currency report matches the expense's original currency.
    if (!isChf) q.where('expenses.original_currency', cur);
    const expenses = await q
      .orderBy('expenses.created_at', 'asc')
      .select(
        'expenses.id',
        'expenses.created_at',
        'expenses.supplier_name',
        'expenses.description',
        'expenses.disposition',
        'expenses.tax_treatment',
        'expenses.status',
        'expenses.event_id',
        'expenses.original_currency',
        'expenses.original_amount_minor',
        'expenses.chf_amount_minor',
        'expenses.net_amount_minor',
        'expenses.vat_amount_minor',
        'expenses.gross_amount_minor',
        'events.event_name as event_name',
      );
    for (const r of expenses) {
      const vat = normMinor(r.vat_amount_minor);
      let net = normMinor(r.net_amount_minor);
      let total = normMinor(r.gross_amount_minor);
      // Fallback to the single stored amount when net/vat/gross are not
      // broken out (internal mileage/per-diem expenses carry only a base
      // amount, no VAT split).
      const base = isChf ? normMinor(r.chf_amount_minor) : normMinor(r.original_amount_minor);
      if (!total) total = (net || vat) ? net + vat : base;
      if (!net) net = total - vat;
      push({
        id: r.id,
        source: 'expense',
        date: r.created_at,
        supplierLabel: (r.supplier_name && String(r.supplier_name).trim()) || '',
        description: r.description || '',
        eventName: r.event_id ? (r.event_name || '') : '',
        disposition: r.disposition || '',
        taxTreatment: r.tax_treatment || 'domestic',
        status: r.status || '',
        netMinor: net,
        vatMinor: vat,
        totalMinor: total,
      });
    }
  }

  // Stable chronological order across both sources.
  rows.sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));

  return { rows, totalNet, totalVat, totalGross, reclaimableVat };
}

// Is the business VAT-registered? (Settings → Accounting). Returns null when the
// setting was never set, so the caller can fall back to a behaviour-preserving
// heuristic (charged output VAT this period ⇒ treat as registered).
async function getVatRegisteredSetting() {
  try {
    const v = await getAppSetting('accounting_vat_registered');
    if (v === undefined || v === null) return null;
    return v === true || v === 1 || v === '1' || v === 'true';
  } catch (_) {
    return null;
  }
}

/**
 * The main entry point.
 *
 *   getTaxReport({ from: '2026-01-01', to: '2026-03-31', currency: 'CHF' })
 *
 * `from` and `to` are inclusive ISO dates (YYYY-MM-DD). `currency` is
 * required and must match `invoices.currency` exactly — mixing
 * currencies in one report is unsound for tax filing, so the API
 * forces a single-currency view.
 *
 * `includeCosts` (default true) adds the Einnahmen-Ausgaben cost side
 * (incoming invoices + expenses) plus a `summary` block (income vs cost
 * vs result, and VAT payable = output VAT − input VAT). Pass false to
 * get the legacy revenue-only shape.
 */
async function getTaxReport({ from, to, currency, includeCosts = true } = {}) {
  if (!from || !to) {
    throw new Error('getTaxReport: `from` and `to` are required (YYYY-MM-DD)');
  }
  if (!currency || typeof currency !== 'string') {
    throw new Error('getTaxReport: `currency` is required');
  }
  const cur = currency.toUpperCase();

  return await withRetry(async () => {
    const dbRows = await db('invoices')
      .leftJoin('customer_accounts', 'invoices.customer_account_id', 'customer_accounts.id')
      .leftJoin('events',            'invoices.event_id',            'events.id')
      .whereBetween('invoices.issue_date', [from, to])
      .where('invoices.currency', cur)
      .whereIn('invoices.status', REPORTABLE_STATUSES)
      .orderBy('invoices.invoice_number', 'asc')
      .select(
        'invoices.id',
        'invoices.invoice_number',
        'invoices.issue_date',
        'invoices.currency',
        'invoices.status',
        'invoices.kind',
        'invoices.vat_rate',
        'invoices.net_amount_minor',
        'invoices.vat_amount_minor',
        'invoices.total_amount_minor',
        'invoices.late_fee_amount_minor',
        'invoices.replaces_invoice_id',
        'customer_accounts.email         as customer_email',
        'customer_accounts.display_name  as customer_display_name',
        'customer_accounts.first_name    as customer_first_name',
        'customer_accounts.last_name     as customer_last_name',
        'customer_accounts.company_name  as customer_company_name',
        // Prefer the invoice's inline snapshot (migration 123) so
        // renames on the events table don't retroactively change
        // historical tax reports; fall back to events.event_name for
        // legacy rows where the snapshot is still null.
        db.raw('COALESCE(invoices.event_name, events.event_name) AS event_name'),
      );

    // Find replacement invoice numbers for any cancelled rows so the
    // UI can render "Bezug → R-XXXX" without an extra round-trip.
    const cancelledIds = dbRows.filter((r) => r.status === 'cancelled').map((r) => r.id);
    const replacedByMap = await loadReplacementsMap(cancelledIds);

    // Skonto aggregate (migration 126). One invoice can have multiple
    // payment-log rows (partial → top-up → top-up → final); we surface
    // the row as "paid with Skonto" if ANY of its log rows carries the
    // flag, and sum the discount across all such rows. Done as a
    // separate query so the main SELECT doesn't need a GROUP BY (which
    // would force every selected column into the GROUP under strict
    // Postgres semantics).
    const skontoByInvoiceId = await loadSkontoMap(dbRows.map((r) => r.id));

    // Bucket totals by VAT rate. Use a string key so 7.7 and 7.70
    // collapse to the same bucket regardless of how the DB rounds.
    const byRate = new Map();
    let grandTotalNet = 0;
    let grandTotalVat = 0;
    let grandTotal    = 0;
    let cancelledCount = 0;

    const rows = dbRows.map((r) => {
      const reported = computeReportedAmounts(r);
      const isCancelled = r.status === 'cancelled';
      if (isCancelled) cancelledCount += 1;
      // Exclude BOTH the cancelled original AND its negative Storno row from the
      // totals. Both stay visible in the row list for the gap-free audit trail,
      // but a Storno (kind='storno', status='sent', amounts stored negative)
      // would otherwise double-subtract: the cancelled original is already
      // netted out by exclusion, so adding the negative storno on top deducts
      // the revenue a second time — making a cancel-and-reissue read as 0 income
      // instead of the reissued amount. See feedback_storno_filter_everywhere.
      if (!isCancelled && r.kind !== 'storno') {
        grandTotalNet += reported.netMinor;
        grandTotalVat += reported.vatMinor;
        grandTotal    += reported.totalMinor;
        const rateKey = String(ensureRate(r.vat_rate).toFixed(2));
        const bucket = byRate.get(rateKey) || {
          vatRate: ensureRate(r.vat_rate),
          netMinor: 0, vatMinor: 0, totalMinor: 0,
        };
        bucket.netMinor   += reported.netMinor;
        bucket.vatMinor   += reported.vatMinor;
        bucket.totalMinor += reported.totalMinor;
        byRate.set(rateKey, bucket);
      }
      const skonto = skontoByInvoiceId.get(r.id) || { applied: false, amountMinor: 0 };
      return {
        id: r.id,
        invoiceNumber: r.invoice_number,
        issueDate: r.issue_date,
        currency: r.currency,
        status: r.status,
        // kind + isReissue drive the lineage badges in the tax-tab
        // table (parity with the admin invoices list). isCancelled
        // already gates the "Cancelled" badge; isReissue gates a
        // "Reissue" badge on invoices created via Cancel & reissue.
        kind: r.kind || 'invoice',
        isCancelled,
        isReissue: !isCancelled && r.replaces_invoice_id != null,
        replacedByInvoiceNumber: isCancelled ? (replacedByMap.get(r.id) || null) : null,
        vatRate: ensureRate(r.vat_rate),
        customerLabel: buildCustomerLabel(r),
        eventName: r.event_name || '',
        netMinor: reported.netMinor,
        vatMinor: reported.vatMinor,
        totalMinor: reported.totalMinor,
        // Skonto aggregate (migration 126). `skontoApplied` flags
        // any row in this invoice's payment log as Skonto-applied;
        // `skontoAmountMinor` is the summed discount across all such
        // rows. Both surfaced so the report consumer (UI / PDF / CSV)
        // can render the column without re-querying the log.
        skontoApplied: skonto.applied,
        skontoAmountMinor: skonto.amountMinor,
      };
    });

    const totalsByVatRate = Array.from(byRate.values()).sort((a, b) => a.vatRate - b.vatRate);

    // Cost side (Einnahmen-Ausgaben). Optional so legacy callers that
    // only want the revenue listing can opt out. The cost side is
    // SUPPLEMENTARY — if it fails (e.g. an accounting table/column missing
    // on an older install) it must NOT take down the core revenue report.
    // Degrade to empty costs + log the real error for diagnosis.
    let costs = { rows: [], totalNet: 0, totalVat: 0, totalGross: 0, reclaimableVat: 0 };
    let costsError = null;
    if (includeCosts) {
      try {
        costs = await loadCosts({ from, to, cur });
      } catch (err) {
        costsError = err.message;
        logger.error?.(`taxReport: cost side failed (revenue still returned): ${err.message}`);
      }
    }

    // VAT-payable honours the accounting settings: when NOT VAT-registered the
    // business doesn't file VAT (payable = 0); when registered it's output VAT
    // minus the RECLAIMABLE input VAT only (foreign non-reclaimable cost VAT is
    // not deducted). Guideline figure — verify with your Treuhänder.
    // PR #622 concern 4: when VAT registration is UNSET we must NOT guess from
    // `grandTotalVat > 0` — a quarter with all-exempt cross-border sales has zero
    // output VAT and would silently flip to "not registered", hiding the reclaim.
    // Treat null as "not configured": refuse to compute a payable, surface a
    // warning in the UI instead.
    const vatRegisteredSetting = await getVatRegisteredSetting();
    const vatRegistrationConfigured = vatRegisteredSetting !== null;
    const vatRegistered = vatRegisteredSetting === true;
    const reclaimableInputVat = costs.reclaimableVat != null ? costs.reclaimableVat : costs.totalVat;

    // Summary: income vs cost vs result. Result = a simplified
    // Einnahmen-Ausgaben surplus (net basis).
    const summary = {
      incomeNetMinor: grandTotalNet,
      incomeVatMinor: grandTotalVat,
      incomeGrossMinor: grandTotal,
      costNetMinor: costs.totalNet,
      costVatMinor: costs.totalVat,
      costGrossMinor: costs.totalGross,
      resultNetMinor: grandTotalNet - costs.totalNet,
      resultGrossMinor: grandTotal - costs.totalGross,
      vatRegistered,
      vatRegistrationConfigured,
      // null (not 0) when registration is unconfigured — the UI renders "—" + a
      // "configure VAT registration" warning rather than a misleading number.
      vatPayableMinor: !vatRegistrationConfigured
        ? null
        : (vatRegistered ? (grandTotalVat - reclaimableInputVat) : 0),
    };

    // Unified ledger (#5 — one typed, signed, sortable list). Outgoing
    // invoices carry POSITIVE amounts; incoming invoices + expenses are
    // NEGATIVE so sorting by value runs income → costs and the column
    // nets toward the Result. The legacy `rows` / `costs` shapes are
    // kept above for back-compat; this is the new canonical surface for
    // the on-screen table + PDF/CSV exports.
    const ledger = [
      ...rows.map((r) => ({
        key: `out-${r.id}`,
        type: 'outgoing',
        date: r.issueDate,
        reference: r.invoiceNumber,
        party: r.customerLabel || '',
        eventName: r.eventName || '',
        vatRate: r.vatRate,
        taxTreatment: null,
        status: r.status,
        isCancelled: r.isCancelled,
        isReissue: r.isReissue,
        kind: r.kind,
        skontoApplied: r.skontoApplied,
        skontoAmountMinor: r.skontoAmountMinor,
        netMinor: r.netMinor,
        vatMinor: r.vatMinor,
        totalMinor: r.totalMinor,
      })),
      ...costs.rows.map((c) => ({
        key: `${c.source}-${c.id}`,
        type: c.source === 'incoming' ? 'incoming' : 'expense',
        date: c.date,
        reference: c.description || '',
        party: c.supplierLabel || '',
        eventName: c.eventName || '',
        vatRate: null,
        taxTreatment: c.taxTreatment || 'domestic',
        status: c.status,
        isCancelled: false,
        isReissue: false,
        kind: null,
        skontoApplied: false,
        skontoAmountMinor: 0,
        netMinor: -Math.abs(c.netMinor),
        vatMinor: -Math.abs(c.vatMinor),
        totalMinor: -Math.abs(c.totalMinor),
      })),
    ];
    ledger.sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));

    return {
      rows,
      totalsByVatRate,
      grandTotalNet,
      grandTotalVat,
      grandTotal,
      cancelledCount,
      costs,
      costsError,
      summary,
      ledger,
      currency: cur,
      period: { from, to },
    };
  });
}

// ---------------------------------------------------------------------
// PDF + CSV renderers
// ---------------------------------------------------------------------

/**
 * Pull the issuer block + date format that the renderers need. Mirrors
 * the slice that invoiceService.buildInvoiceRenderContext builds for
 * the regular invoice/quote PDFs so the letterhead looks identical.
 */
async function loadRenderContext(locale) {
  const { profile } = await businessProfileService.getProfile();
  let dateFormat = null;
  try {
    const raw = await getAppSetting('general_date_format');
    if (raw && typeof raw === 'object' && raw.format) dateFormat = raw;
    else if (typeof raw === 'string' && raw.trim()) dateFormat = { format: raw.trim() };
  } catch (_) { /* fall back to renderer default */ }

  const issuer = profile ? {
    companyName: profile.company_name,
    addressLine1: profile.address_line1,
    addressLine2: profile.address_line2,
    postalCode: profile.postal_code,
    city: profile.city,
    state: profile.state,
    countryCode: profile.country_code,
    countryName: profile.country_name || null,
    phone: profile.phone, mobile: profile.mobile, email: profile.email, website: profile.website,
    footerLine: profile.footer_line,
    vatId: profile.vat_id,
    logoPath: profile.logo_path,
    pdfFontTtfPath: profile.pdf_font_ttf_path,
    pdfFontFamily: profile.pdf_font_family || null,
    showLogo: profile.pdf_show_logo == null ? true
      : (profile.pdf_show_logo === true || profile.pdf_show_logo === 1 || profile.pdf_show_logo === '1'),
    showCompanyName: profile.pdf_show_company_name == null ? true
      : (profile.pdf_show_company_name === true || profile.pdf_show_company_name === 1 || profile.pdf_show_company_name === '1'),
    logoHeight: profile.pdf_logo_height == null ? 56 : Number(profile.pdf_logo_height),
    companyNameInline: profile.pdf_company_name_inline === true || profile.pdf_company_name_inline === 1 || profile.pdf_company_name_inline === '1',
    // Folding marks would clutter a tax-report (no envelope window in
    // play); always suppress regardless of the profile setting.
    foldingMarks: 'none',
  } : {};

  return { issuer, dateFormat, locale: locale || profile?.default_locale || 'de' };
}

// Page layout for the tax-report table. Sized for A4 landscape (762pt
// content width). Sums to ~759 leaving ~3pt slack for the right margin.
//
// "Status" column lives at the far right so the cancelled marker
// doesn't crowd the invoice number. The invoice column itself stays
// uncluttered with just "R-2026-0001" — easier to scan for an
// auditor looking at the sequence.
const TAX_TABLE_COLS = [
  { key: 'idx',       labelKey: 'tax_col_no',        width: 22,  align: 'right' },
  { key: 'type',      labelKey: 'tax_col_type',      width: 58,  align: 'left'  },
  { key: 'date',      labelKey: 'tax_col_date',      width: 56,  align: 'left'  },
  { key: 'reference', labelKey: 'tax_col_reference', width: 88,  align: 'left'  },
  { key: 'party',     labelKey: 'tax_col_party',     width: 116, align: 'left'  },
  { key: 'event',     labelKey: 'tax_col_event',     width: 86,  align: 'left'  },
  { key: 'tax',       labelKey: 'tax_col_tax',       width: 64,  align: 'left'  },
  { key: 'net',       labelKey: 'tax_col_net',       width: 70,  align: 'right' },
  { key: 'vat',       labelKey: 'tax_col_vat',       width: 58,  align: 'right' },
  { key: 'total',     labelKey: 'tax_col_total',     width: 80,  align: 'right' },
  // Skonto column (migration 126) — blank for non-Skonto rows so the
  // column reads quietly until it has data.
  { key: 'skonto',    labelKey: 'tax_col_skonto',    width: 50,  align: 'right' },
];

function colX(leftMargin, index) {
  let x = leftMargin;
  for (let i = 0; i < index; i += 1) x += TAX_TABLE_COLS[i].width;
  return x;
}

function drawTaxTableHeader(doc, leftMargin, y, locale, fonts) {
  doc.font(fonts.bold).fontSize(8.5).fillColor('#000');
  for (let i = 0; i < TAX_TABLE_COLS.length; i += 1) {
    const col = TAX_TABLE_COLS[i];
    doc.text(t(locale, col.labelKey), colX(leftMargin, i) + 2, y, {
      width: col.width - 4, align: col.align,
    });
  }
  const headerBottom = y + 14;
  doc.moveTo(leftMargin, headerBottom)
    .lineTo(leftMargin + TAX_TABLE_COLS.reduce((s, c) => s + c.width, 0), headerBottom)
    .lineWidth(0.6).strokeColor('#000').stroke();
  return headerBottom + 4;
}

function formatVatRate(rate, locale) {
  // 7.7 → "7.7 %" in en, "7,7 %" in de. Two decimals stripped for
  // tidiness when zero (8.10 → "8.1 %").
  const n = Number(rate || 0);
  const intlLocale = locale === 'de' ? 'de-CH' : 'en-GB';
  const formatted = new Intl.NumberFormat(intlLocale, {
    minimumFractionDigits: 0, maximumFractionDigits: 2,
  }).format(n);
  return `${formatted} %`;
}

function rowCellValues(row, idx, locale, dateFormat, currency) {
  const intlLocale = locale === 'de' ? 'de-CH' : 'en-GB';
  const typeLabel = t(
    locale,
    row.type === 'outgoing' ? 'tax_type_outgoing'
      : row.type === 'incoming' ? 'tax_type_incoming'
        : 'tax_type_expense',
  );
  const reference = row.isCancelled
    ? `${row.reference || ''} (${t(locale, 'tax_status_cancelled')})`
    : (row.reference || '');
  return {
    idx: String(idx),
    type: typeLabel,
    date: formatDate(row.date, dateFormat),
    reference,
    party: row.party || '',
    event: row.eventName || '',
    tax: row.type === 'outgoing' ? formatVatRate(row.vatRate, locale) : (row.taxTreatment || ''),
    net: formatMinor(row.netMinor, currency, intlLocale),
    vat: formatMinor(row.vatMinor, currency, intlLocale),
    total: formatMinor(row.totalMinor, currency, intlLocale),
    skonto: row.skontoApplied
      ? formatMinor(row.skontoAmountMinor, currency, intlLocale)
      : '',
  };
}

/**
 * Render the tax report as a PDF buffer.
 *
 *   renderTaxReportPdf({ from, to, currency, locale })  → Promise<Buffer>
 *
 * Currency is required and used to scope the data (same contract as
 * getTaxReport). Locale defaults to the business profile's default.
 */
// Export scope (PR/Liechtenstein follow-up): the readable PDF/CSV exports can be
// limited to the income or the cost side — handy when the Treuhänder only needs
// one basis (e.g. income for the 20%-Gewinnungskosten flat deduction). The
// on-screen report is unaffected; only the exports filter.
const TAX_EXPORT_SCOPES = ['all', 'income', 'cost'];
function normalizeScope(scope) {
  return TAX_EXPORT_SCOPES.includes(scope) ? scope : 'all';
}
function scopeLedger(ledger, scope) {
  if (scope === 'income') return (ledger || []).filter((r) => r.type === 'outgoing');
  if (scope === 'cost') return (ledger || []).filter((r) => r.type === 'incoming' || r.type === 'expense');
  return ledger || [];
}

async function renderTaxReportPdf({ from, to, currency, locale, scope } = {}) {
  const report = await getTaxReport({ from, to, currency });
  const xScope = normalizeScope(scope);
  report.ledger = scopeLedger(report.ledger, xScope);
  // The per-rate breakdown is income-only — drop it from a cost-only export.
  if (xScope === 'cost') report.totalsByVatRate = [];
  const showIncome = xScope !== 'cost';
  const showCosts = xScope !== 'income';
  const showResult = xScope === 'all';
  const renderCtx = await loadRenderContext(locale);
  const useLocale = renderCtx.locale;
  const intlLocale = useLocale === 'de' ? 'de-CH' : 'en-GB';

  const { doc, page, fonts } = pdfService.createBaseDocument({
    orientation: 'landscape',
    issuer: renderCtx.issuer,
    info: {
      Title: `${t(useLocale, 'tax_title')} ${report.period.from}–${report.period.to}`,
      Author: renderCtx.issuer.companyName || 'picpeak',
    },
  });

  return await new Promise((resolve, reject) => {
    try {
      const chunks = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const leftMargin = page.marginLeft;
      // Issuer block: top-right, same width pattern as the existing
      // invoice/quote letterhead (180pt) so the branding feels
      // consistent across all admin-facing PDFs.
      const issuerWidth = 180;
      const issuerX = page.width - page.marginRight - issuerWidth;
      const issuerY = page.marginTop + 4;
      const issuerEndY = pdfService.drawIssuerBlock(
        doc, renderCtx.issuer, issuerX, issuerY, issuerWidth, useLocale
      );

      // Title block on the left.
      doc.font(fonts.bold).fontSize(18).fillColor('#000')
        .text(t(useLocale, 'tax_title'), leftMargin, page.marginTop + 4, {
          width: page.contentWidth - issuerWidth - 20, align: 'left',
        });

      doc.font(fonts.body).fontSize(10).fillColor('#333');
      const periodLine = `${t(useLocale, 'tax_period')}: ${formatDate(report.period.from, renderCtx.dateFormat)} – ${formatDate(report.period.to, renderCtx.dateFormat)}`;
      doc.text(periodLine, leftMargin, page.marginTop + 30, {
        width: page.contentWidth - issuerWidth - 20, align: 'left',
      });
      doc.text(`${t(useLocale, 'tax_currency')}: ${report.currency}`,
        leftMargin, page.marginTop + 46, {
          width: page.contentWidth - issuerWidth - 20, align: 'left',
        });

      // Table starts below whichever block (issuer or title) ends lower.
      let y = Math.max(issuerEndY, page.marginTop + 70) + 14;
      y = drawTaxTableHeader(doc, leftMargin, y, useLocale, fonts);

      doc.fontSize(8.5);
      const tableBottomLimit = page.height - page.marginBottom - 110; // leave room for totals
      const tableWidth = TAX_TABLE_COLS.reduce((s, c) => s + c.width, 0);

      if (report.ledger.length === 0) {
        doc.font(fonts.body).fontSize(10).fillColor('#555')
          .text(t(useLocale, 'tax_no_invoices'), leftMargin, y + 6, {
            width: tableWidth, align: 'center',
          });
        y += 24;
      }

      // Row height is now DYNAMIC — computed per row as the max
      // rendered height across every cell at its column width. This
      // means a cell that wraps to two lines (long customer label,
      // multi-line event name, "Storniert" tag in a narrow status
      // column) makes the whole row taller instead of overlapping
      // the row below. The minimum keeps tight rows readable.
      const ROW_MIN_HEIGHT = 14;
      const ROW_VERTICAL_PADDING = 4; // space between text and the separator line
      const safeStr = (v) => (v == null ? '' : String(v));

      // Measure how tall a value would render in the given column.
      // Numeric / aligned cells use `lineBreak: false` so they never
      // wrap (they're either ints or money strings whose width we
      // budget for) — only text cells (customer, event, invoice,
      // status) opt into natural wrapping.
      const isWrappable = (col) => ['type', 'reference', 'party', 'event', 'tax'].includes(col.key);
      const measureCellHeight = (value, col) => {
        const s = safeStr(value);
        if (!s) return 0;
        const opts = isWrappable(col)
          ? { width: col.width - 4, align: col.align }
          : { width: col.width - 4, align: col.align, lineBreak: false };
        // `doc.heightOfString` reads the current font + fontSize, so
        // we set the body font + 8.5pt before each row's measurement
        // pass and the values stay consistent with the actual draw.
        return doc.heightOfString(s, opts);
      };

      for (let i = 0; i < report.ledger.length; i += 1) {
        const row = report.ledger[i];
        const cells = rowCellValues(row, i + 1, useLocale, renderCtx.dateFormat, report.currency);

        // Set the font BEFORE measuring so heightOfString reads the
        // exact rendering state we'll use for doc.text below.
        doc.font(fonts.body).fontSize(8.5);

        let textHeight = ROW_MIN_HEIGHT - ROW_VERTICAL_PADDING;
        for (const col of TAX_TABLE_COLS) {
          const h = measureCellHeight(cells[col.key], col);
          if (h > textHeight) textHeight = h;
        }
        const rowH = Math.ceil(textHeight) + ROW_VERTICAL_PADDING;

        // Page break check uses the actual row height we're about to
        // draw, not the old hard-coded constant — long rows can't
        // sneak past the bottom margin. Pass margins explicitly so the
        // new page inherits the same 40pt frame as page 1 — without
        // this, PDFKit's addPage falls back to its 72pt default and
        // the footer-Y math (`page.height - page.marginBottom - 12`)
        // ends up positioned for a margin the page doesn't actually
        // have, which is what made the page-number footer drift onto
        // the wrong row of subsequent pages.
        if (y + rowH > tableBottomLimit) {
          doc.addPage({
            size: 'A4', layout: 'landscape',
            margins: {
              top: page.marginTop, bottom: page.marginBottom,
              left: page.marginLeft, right: page.marginRight,
            },
          });
          y = page.marginTop;
          y = drawTaxTableHeader(doc, leftMargin, y, useLocale, fonts);
          doc.font(fonts.body).fontSize(8.5);
        }

        doc.fillColor(row.isCancelled ? '#888' : '#000');

        for (let c = 0; c < TAX_TABLE_COLS.length; c += 1) {
          const col = TAX_TABLE_COLS[c];
          const opts = isWrappable(col)
            ? { width: col.width - 4, align: col.align }
            : { width: col.width - 4, align: col.align, lineBreak: false };
          doc.text(safeStr(cells[col.key]), colX(leftMargin, c) + 2, y, opts);
        }

        // Light separator under each row, drawn at the dynamic
        // bottom edge — not at a fixed offset.
        doc.moveTo(leftMargin, y + rowH - 1)
          .lineTo(leftMargin + tableWidth, y + rowH - 1)
          .lineWidth(0.3).strokeColor('#e0e0e0').stroke();
        y += rowH;
      }

      // Totals block. Lives in the right half of the page so it
      // doesn't fight with the cancelled footnote on the left.
      //
      // Estimate the totals block height up-front: header (16) +
      // 13pt per VAT bucket row + divider (8) + three grand-total
      // rows (39) + a 12pt cushion for the footer below. If that
      // doesn't fit on the current page, force a new page now —
      // otherwise PDFKit auto-paginates mid-totals, creating phantom
      // pages whose footer ends up at unexpected Y positions on the
      // subsequent bufferedPageRange loop.
      // Header (16) + one line per VAT bucket (13) + divider (8) +
      // three income/costs/result summary rows (39) + a 12pt cushion.
      const summaryHeight = 8 + (3 * 13);
      const totalsHeightEstimate = 16 + (report.totalsByVatRate.length * 13) + 12 + summaryHeight;
      const footerReserve = 24; // 12 above + 12 of page-number text room
      if (y + 12 + totalsHeightEstimate + footerReserve > page.height - page.marginBottom) {
        doc.addPage({
          size: 'A4', layout: 'landscape',
          margins: {
            top: page.marginTop, bottom: page.marginBottom,
            left: page.marginLeft, right: page.marginRight,
          },
        });
        y = page.marginTop;
      }
      const totalsTop = y + 12;
      const totalsBoxWidth = 360;
      const totalsX = page.width - page.marginRight - totalsBoxWidth;

      doc.font(fonts.bold).fontSize(10).fillColor('#000')
        .text(t(useLocale, 'tax_totals_by_rate'), totalsX, totalsTop, {
          width: totalsBoxWidth, align: 'left',
        });

      let ty = totalsTop + 16;
      doc.font(fonts.body).fontSize(9);
      for (const bucket of report.totalsByVatRate) {
        const labelLeft = `${formatVatRate(bucket.vatRate, useLocale)}`;
        doc.text(labelLeft, totalsX, ty, { width: 80, align: 'left' });
        doc.text(formatMinor(bucket.netMinor, report.currency, intlLocale),
          totalsX + 80, ty, { width: 90, align: 'right' });
        doc.text(formatMinor(bucket.vatMinor, report.currency, intlLocale),
          totalsX + 175, ty, { width: 90, align: 'right' });
        doc.text(formatMinor(bucket.totalMinor, report.currency, intlLocale),
          totalsX + 270, ty, { width: 90, align: 'right' });
        ty += 13;
      }
      // Divider above the income / costs / result summary.
      doc.moveTo(totalsX, ty + 2).lineTo(totalsX + totalsBoxWidth, ty + 2)
        .lineWidth(0.6).strokeColor('#000').stroke();
      ty += 6;
      // Income / Costs / Result summary (mirrors the on-screen summary
      // box). Costs are shown NEGATIVE so the Result reads as a plain
      // sum of the column. Net / VAT / Gross across the three lines.
      const s = report.summary;
      const summaryLine = (labelKey, netMinor, vatMinor, grossMinor, bold) => {
        doc.font(bold ? fonts.bold : fonts.body).fontSize(9).fillColor('#000');
        doc.text(t(useLocale, labelKey), totalsX, ty, { width: 80, align: 'left' });
        doc.text(formatMinor(netMinor, report.currency, intlLocale), totalsX + 80, ty, { width: 90, align: 'right' });
        doc.text(formatMinor(vatMinor, report.currency, intlLocale), totalsX + 175, ty, { width: 90, align: 'right' });
        doc.text(formatMinor(grossMinor, report.currency, intlLocale), totalsX + 270, ty, { width: 90, align: 'right' });
        ty += 13;
      };
      if (showIncome) summaryLine('tax_summary_income', s.incomeNetMinor, s.incomeVatMinor, s.incomeGrossMinor, !showResult);
      if (showCosts) summaryLine('tax_summary_costs', -Math.abs(s.costNetMinor), -Math.abs(s.costVatMinor), -Math.abs(s.costGrossMinor), !showResult);
      if (showResult) summaryLine('tax_summary_result', s.resultNetMinor, s.vatPayableMinor, s.resultGrossMinor, true);

      // Cancelled footnote (bottom-left). Only when there are any.
      if (report.cancelledCount > 0) {
        doc.font(fonts.body).fontSize(8).fillColor('#555')
          .text(
            t(useLocale, 'tax_cancelled_footnote', { count: report.cancelledCount }),
            leftMargin, totalsTop,
            { width: page.contentWidth - totalsBoxWidth - 20, align: 'left' }
          );
      }

      // Page x of N footer (bottom-right). Done after all body
      // rendering via PDFKit's bufferPages so we know the final count
      // before stamping. Resets fill colour + font so the stamp looks
      // identical on every page regardless of where rendering ended.
      const range = doc.bufferedPageRange();
      for (let pageIdx = 0; pageIdx < range.count; pageIdx += 1) {
        doc.switchToPage(range.start + pageIdx);
        const pageLabel = t(useLocale, 'page_of', {
          current: pageIdx + 1, total: range.count,
        });
        // Position the page label just ABOVE the bottom margin —
        // keeping the baseline inside the content area prevents
        // PDFKit's layout engine from auto-paginating when the
        // 8pt-tall text wouldn't fit between the requested y and
        // the bottom of the page. The previous +6 offset pushed the
        // y into the margin, which made PDFKit add a fresh blank
        // page for every label, doubling the page count. Mirror the
        // safe `- 12` offset used by the invoice/quote renderer in
        // pdfService.renderDocument().
        doc.font(fonts.body).fontSize(8).fillColor('#888')
          .text(pageLabel,
            page.width - page.marginRight - 160,
            page.height - page.marginBottom - 12,
            { width: 160, align: 'right', lineBreak: false });
      }

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Render the tax report as a CSV string. Header row in the admin's
 * locale; numbers use a dot decimal separator (universal for CSV
 * import into Excel/Numbers/accounting software) so we don't have to
 * thread locale-specific formatting into the export.
 *
 *   renderTaxReportCsv({ from, to, currency, locale })
 *     → Promise<{ content, filename, contentType }>
 */
async function renderTaxReportCsv({ from, to, currency, locale, scope } = {}) {
  const report = await getTaxReport({ from, to, currency });
  const xScope = normalizeScope(scope);
  report.ledger = scopeLedger(report.ledger, xScope);
  const useLocale = locale || 'en';

  const escape = (cell) => {
    // Formula-injection defence (Excel/Numbers) THEN RFC-4180 quote-wrap. The
    // quote wrap alone does NOT stop formula evaluation — only the leading
    // single-quote prefix does.
    const s = neutralizeSpreadsheetFormula(cell === null || cell === undefined ? '' : String(cell));
    return `"${s.replace(/"/g, '""')}"`;
  };

  const minorToDotDecimal = (m) => ((Number(m) || 0) / 100).toFixed(2);

  // yyyy-mm-dd, robust to Postgres returning dates as JS Date objects (SQLite
  // returns strings) — raw String(dateObj) is "Thu Jan 15", not an ISO date.
  const isoDate = (d) => {
    if (!d) return '';
    if (d instanceof Date) {
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }
    return String(d).slice(0, 10);
  };

  const typeLabelKey = (type) => (
    type === 'outgoing' ? 'tax_type_outgoing'
      : type === 'incoming' ? 'tax_type_incoming'
        : 'tax_type_expense'
  );

  // ONE unified ledger table. Amounts are already signed in the ledger
  // (outgoing positive, costs negative) — emitted as-is.
  const headers = [
    t(useLocale, 'tax_col_no'),
    t(useLocale, 'tax_col_type'),
    t(useLocale, 'tax_col_date'),
    t(useLocale, 'tax_col_reference'),
    t(useLocale, 'tax_col_party'),
    t(useLocale, 'tax_col_event'),
    t(useLocale, 'tax_col_tax'),
    `${t(useLocale, 'tax_col_net')} (${report.currency})`,
    `${t(useLocale, 'tax_col_vat')} (${report.currency})`,
    `${t(useLocale, 'tax_col_total')} (${report.currency})`,
    // Migration 126 — Skonto export. `tax_col_skonto` is the discount
    // amount in major units; admin's accountant reconciles the line.
    `${t(useLocale, 'tax_col_skonto')} (${report.currency})`,
  ];

  const lines = [headers.map(escape).join(',')];
  report.ledger.forEach((row, i) => {
    const reference = row.isCancelled
      ? `${row.reference || ''} (${t(useLocale, 'tax_status_cancelled')})`
      : (row.reference || '');
    const tax = row.type === 'outgoing'
      ? Number(row.vatRate).toFixed(2)
      : (row.taxTreatment || '');
    lines.push([
      i + 1,
      t(useLocale, typeLabelKey(row.type)),
      isoDate(row.date),
      reference,
      row.party,
      row.eventName,
      tax,
      minorToDotDecimal(row.netMinor),
      minorToDotDecimal(row.vatMinor),
      minorToDotDecimal(row.totalMinor),
      row.skontoApplied ? minorToDotDecimal(row.skontoAmountMinor) : '',
    ].map(escape).join(','));
  });

  // Trailing blank line, then the income / costs / result summary block.
  const summary = report.summary;
  if (summary) {
    lines.push('');
    lines.push(escape(t(useLocale, 'tax_summary_section')));
    const sline = (labelKey, net, vat, gross) => lines.push([
      '', '', '', t(useLocale, labelKey), '', '',
      minorToDotDecimal(net), minorToDotDecimal(vat), minorToDotDecimal(gross),
    ].map(escape).join(','));
    if (xScope !== 'cost') sline('tax_summary_income', summary.incomeNetMinor, summary.incomeVatMinor, summary.incomeGrossMinor);
    if (xScope !== 'income') sline('tax_summary_costs', summary.costNetMinor, summary.costVatMinor, summary.costGrossMinor);
    if (xScope === 'all') sline('tax_summary_result', summary.resultNetMinor, summary.vatPayableMinor, summary.resultGrossMinor);
  }

  const content = lines.join('\r\n') + '\r\n';
  const scopeTag = xScope === 'all' ? '' : `${xScope}_`;
  const filename = `tax_report_${scopeTag}${report.period.from}_to_${report.period.to}_${report.currency}.csv`;
  return { content, filename, contentType: 'text/csv; charset=utf-8' };
}

module.exports = {
  getTaxReport,
  renderTaxReportPdf,
  renderTaxReportCsv,
  // Exposed for unit tests.
  _internal: { grossUpLateFee, computeReportedAmounts, buildCustomerLabel, formatVatRate, loadCosts, scopeLedger, normalizeScope },
};
