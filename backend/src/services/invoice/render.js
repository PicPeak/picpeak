// Extracted verbatim from invoiceService.js — see ../invoiceService.js for the
// module-level overview. Do not add behavior here without updating the entry re-exports.

const { db } = require('../../database/db');
const { getAppSetting } = require('../../utils/appSettings');
const { cleanNetMinor } = require('../../utils/invoiceRounding');
const { AppError } = require('../../utils/errors');
const businessProfileService = require('../businessProfileService');
const { buildIssuerBlock, buildRecipientBlock } = require('../_renderContext');
const pdfService = require('../pdfService');
const { ensureInt, ensureNumber } = require('../../utils/numericHelpers');
const { getHierarchyHelpers } = require('./helpers');
const { getInvoiceById } = require('./queries');


async function buildInvoiceRenderContext(invoice, lineItems) {
  const { profile } = await businessProfileService.getProfile();
  const customer = await db('customer_accounts').where({ id: invoice.customer_account_id }).first();
  const bank = invoice.business_bank_account_id
    ? await db('business_bank_accounts').where({ id: invoice.business_bank_account_id }).first()
    : await businessProfileService.resolveBankAccountForCurrency(invoice.currency);

  // Resolve the PDF logo to a verified absolute disk path. The
  // helper exhaustively tries:
  //   1. business_profile.logo_path
  //   2. app_settings.branding_logo_path  (absolute multer path)
  //   3. app_settings.branding_logo_url   (URL path)
  // …and for each, generates ~7 candidate disk locations before
  // giving up. Returns null + logs a detailed warning when nothing
  // resolves. Already-verified path means the renderer never has
  // to second-guess.
  const { resolveLogoFile } = require('../../utils/resolveLogoFile');
  const resolvedLogoPath = await resolveLogoFile(profile);

  // QR format resolution order (per-invoice override → profile
  // default → none) gated by the global enable toggle. The earlier
  // version had an operator-precedence bug that effectively dropped
  // the profile default; this rewrites it as plain if/else for
  // readability + correctness.
  const qrGloballyEnabled = (await getAppSetting('crm_invoices_qr_enabled')) !== false;
  let resolvedQrFormat = 'none';
  if (qrGloballyEnabled) {
    resolvedQrFormat = invoice.qr_format || profile?.default_qr_format || 'none';
  }

  // Resolve the payment-term snapshot to thread Skonto + net-days into
  // the PDF's "Zahlungsbedingungen" block. Three sources, in priority
  // order:
  //   1. The invoice's OWN snapshot (migration 113 — set when admin
  //      picks a template directly in the New Invoice form).
  //   2. The originating quote's snapshot, if this invoice was
  //      created from one.
  //   3. The global CRM defaults (settings tab) — `crm_invoices_*`.
  // Both layers above are wrapped in `paymentTerm` exactly as
  // quoteService builds it so pdfService.drawPaymentBlock renders
  // the same block on both document types.
  let paymentTerm = null;

  // Invoice-level snapshot wins when set.
  if (invoice.payment_term_snapshot) {
    const snapshot = typeof invoice.payment_term_snapshot === 'string'
      ? (() => { try { return JSON.parse(invoice.payment_term_snapshot); } catch { return null; } })()
      : invoice.payment_term_snapshot;
    if (snapshot) {
      paymentTerm = {
        description: snapshot.description,
        netDays: snapshot.net_days,
        skontoPercent: snapshot.skonto_percent,
        skontoWithinDays: snapshot.skonto_within_days,
      };
    }
  }

  // Load the source quote once — used for the payment-term snapshot
  // fallback AND for the "Bezug: Angebot Q-..." reference line on
  // the invoice PDF. We deliberately keep invoice numbers on a
  // strict monotonic sequence (tax compliance) and surface the link
  // as a text reference rather than mirroring the number.
  let sourceQuote = null;
  if (invoice.source_quote_id) {
    sourceQuote = await db('quotes').where({ id: invoice.source_quote_id }).first();
    if (!paymentTerm && sourceQuote?.payment_term_snapshot) {
      const snapshot = typeof sourceQuote.payment_term_snapshot === 'string'
        ? (() => { try { return JSON.parse(sourceQuote.payment_term_snapshot); } catch { return null; } })()
        : sourceQuote.payment_term_snapshot;
      if (snapshot) {
        paymentTerm = {
          description: snapshot.description,
          netDays: snapshot.net_days,
          skontoPercent: snapshot.skonto_percent,
          skontoWithinDays: snapshot.skonto_within_days,
        };
      }
    }
  }
  // Globally-default Skonto values, always loaded. Used either to
  // FILL a partial source-quote snapshot OR to seed the whole
  // paymentTerm when there's no source quote. Both reads survive
  // missing rows (returns null), unset values (NaN guarded), and
  // string-encoded numbers from app_settings.
  const defaultSkontoPercentRaw = await getAppSetting('crm_invoices_skonto_percent_default');
  const defaultSkontoDaysRaw = await getAppSetting('crm_invoices_skonto_business_days');
  const defaultSkontoPercent = Number.isFinite(Number(defaultSkontoPercentRaw)) && Number(defaultSkontoPercentRaw) > 0
    ? Number(defaultSkontoPercentRaw) : null;
  const defaultSkontoDays = Number.isFinite(Number(defaultSkontoDaysRaw)) && Number(defaultSkontoDaysRaw) > 0
    ? parseInt(defaultSkontoDaysRaw, 10) : null;

  if (paymentTerm) {
    // The source quote's snapshot may carry only some of the Skonto
    // fields (e.g. when the template predates Skonto support); fill
    // missing parts from the global defaults so the PDF still shows
    // the row whenever there's enough info to render it.
    if (paymentTerm.skontoPercent == null && defaultSkontoPercent != null) {
      paymentTerm.skontoPercent = defaultSkontoPercent;
    }
    if (paymentTerm.skontoWithinDays == null && defaultSkontoDays != null) {
      paymentTerm.skontoWithinDays = defaultSkontoDays;
    }
  } else {
    // Ad-hoc invoice (no source quote). Build the paymentTerm from
    // the global defaults. Renders only when BOTH percent + days are
    // set + > 0 (pdfService.drawPaymentBlock guards on that).
    paymentTerm = {
      description: null,
      netDays: 30,
      skontoPercent: defaultSkontoPercent,
      skontoWithinDays: defaultSkontoDays,
    };
  }

  // Per-invoice Skonto opt-out (migration 126). The
  // `resolveSkontoPercentForInvoice` helper above already respects
  // this for payment-tracking surfaces, but the PDF render path was
  // assembling `paymentTerm.skontoPercent/Days` from the snapshot or
  // global defaults and ignoring the flag — so ticking "Disable
  // Skonto" on the invoice cleared it from "Paid with Skonto" buttons
  // but still printed the discount row on the PDF. Zero out both
  // fields here so pdfService.drawPaymentBlock's
  // `paymentTerm?.skontoPercent && paymentTerm?.skontoWithinDays`
  // guard suppresses the row. The per-customer opt-out (migration 112)
  // is honoured here too — a customer flagged skonto_disabled never
  // prints the discount row, mirroring resolveSkontoPercentForInvoice.
  if (invoice.skonto_disabled || customer?.skonto_disabled) {
    paymentTerm.skontoPercent = null;
    paymentTerm.skontoWithinDays = null;
  }

  // Global date format from Settings → General (general_date_format).
  // Stored as JSON `{ format, locale }`; missing or malformed entries
  // fall back to DD.MM.YYYY in the renderer.
  let dateFormat = null;
  try {
    const raw = await getAppSetting('general_date_format');
    if (raw && typeof raw === 'object' && raw.format) dateFormat = raw;
    else if (typeof raw === 'string' && raw.trim()) dateFormat = { format: raw.trim() };
  } catch (_) { /* fall back to default */ }

  // Sub-cent reconciliation (crm_invoice_round_total). "Betrag Netto"
  // shows the sum of the visible line totals so it foots with the items;
  // the stored net may be the clean (rounded-once) value, and the gap is
  // shown as a "Rundung" row. Legacy/unrounded invoices have equal
  // values ⇒ adjustment 0, no row. Suppressed on Storno/Mahnung: those
  // negate the stored net and flip line-total signs at render, so the
  // forward "storedNet − Σ lines" derivation doesn't apply.
  const isReversalDoc = invoice.kind === 'storno' || invoice.kind === 'mahnung';
  const displayedNetMinor = isReversalDoc
    ? ensureInt(invoice.net_amount_minor)
    : lineItems.reduce(
      (s, li) => (li.parent_line_item_id == null && (li.parent_position == null || li.parent_position === '')
        ? s + ensureInt(li.line_total_minor) : s),
      0,
    );
  const roundingAdjustmentMinor = isReversalDoc
    ? 0
    : ensureInt(invoice.net_amount_minor) - displayedNetMinor;

  return {
    locale: invoice.language || profile?.default_locale || 'de',
    currency: invoice.currency,
    qrFormat: resolvedQrFormat,
    dateFormat,
    // Shared issuer + recipient builders. Invoices skip the quote-only
    // payment-block toggles; the invoice PDF always shows the payment
    // block. See backend/src/services/_renderContext.js.
    issuer: buildIssuerBlock(profile, resolvedLogoPath),
    recipient: buildRecipientBlock(profile, customer),
    bank: bank ? {
      accountHolder: bank.account_holder || profile?.company_name,
      iban: bank.iban, bic: bank.bic, currency: bank.currency,
    } : null,
    paymentTerm,
    lineItems: lineItems.map((li) => ({
      quantity: li.quantity,
      description: li.description,
      unitPriceMinor: li.unit_price_minor,
      discountPercent: li.discount_percent,
      lineTotalMinor: li.line_total_minor,
      // Migration 119 — hierarchy + notes flow through to PDF.
      parentLineItemId: li.parent_line_item_id || null,
      parentPosition: li.parent_position == null ? null : Number(li.parent_position),
      detailsText: li.details_text || null,
    })),
    totals: {
      netAmountMinor: displayedNetMinor,
      roundingAdjustmentMinor,
      vatRate: invoice.vat_rate,
      // Migration 130 — VAT-code snapshot (so re-editing preserves it).
      vatCode: invoice.vat_code ?? null,
      vatAmountMinor: invoice.vat_amount_minor,
      shippingAmountMinor: invoice.shipping_amount_minor,
      totalAmountMinor: invoice.total_amount_minor,
      // The Mahngebühr is shown on the separate Mahnung document, NEVER on
      // the (immutable) invoice — so the invoice render always reports 0. The
      // Mahnung render path (applyReminder) overrides this with the tracked fee.
      lateFeeAmountMinor: 0,
    },
    doc: {
      // Document type discriminator. `'invoice'` (default) renders
      // the standard invoice layout. `'storno'` switches the title
      // to "Stornorechnung", forces the mandatory "Storno zu …"
      // reference line, displays signed totals, and suppresses the
      // payment terms / IBAN / QR-bill sections (cancellation
      // documents aren't payment instruments).
      kind: invoice.kind || 'invoice',
      invoiceNumber: invoice.invoice_number,
      issueDate: invoice.issue_date,
      dueDate: invoice.due_date,
      totalAmountMinor: invoice.total_amount_minor,
      lateFeeMinor: 0,
      // Reminder level — drives Skonto suppression on second
      // reminders (no early-payment discount once the customer
      // is in dunning).
      reminderLevel: invoice.reminder_level || 0,
      // PDF renderer draws "Bezug: Angebot Q-..." under the title
      // when set. Empty/null suppresses the line (standalone invoice).
      sourceQuoteNumber: sourceQuote?.quote_number || null,
      // When this invoice replaces a previously-cancelled one
      // (migration 114, reissue workflow), the renderer stamps a
      // second reference line: "Bezug: Ersetzt Rechnung R-XXXX vom
      // DATE".
      replacesInvoice: await (async () => {
        if (!invoice.replaces_invoice_id) return null;
        const prior = await db('invoices')
          .where({ id: invoice.replaces_invoice_id })
          .select('invoice_number', 'issue_date').first();
        return prior
          ? { number: prior.invoice_number, issueDate: prior.issue_date }
          : null;
      })(),
      // Storno reference — populated only on `kind='storno'` rows.
      // The renderer turns it into the mandatory "Storno zu Rechnung
      // R-XXXX vom DATE" line under the title. Drives §14c-defensible
      // traceability: the customer sees explicitly what was reversed.
      cancelsInvoice: await (async () => {
        if (!invoice.cancels_invoice_id) return null;
        const prior = await db('invoices')
          .where({ id: invoice.cancels_invoice_id })
          .select('invoice_number', 'issue_date').first();
        return prior
          ? { number: prior.invoice_number, issueDate: prior.issue_date }
          : null;
      })(),
    },
  };
}

async function renderInvoicePdfBuffer(invoiceId) {
  const data = await getInvoiceById(invoiceId);
  if (!data) throw new AppError('Invoice not found', 404);
  // Imported (historical) invoices store the original PDF on disk
  // — short-circuit the renderer and stream the file untouched so
  // legal documents stay byte-identical to the source. Path is
  // stored relative to STORAGE_PATH but we accept absolute too.
  if (data.invoice.imported_pdf_path) {
    const fs = require('fs');
    const path = require('path');
    const { getStoragePath } = require('../../config/storage');
    const raw = String(data.invoice.imported_pdf_path).trim();
    const candidates = [
      path.isAbsolute(raw) ? raw : null,
      path.join(getStoragePath(), raw.replace(/^\/+/, '')),
    ].filter(Boolean);
    const found = candidates.find((p) => {
      try { return fs.existsSync(p) && fs.statSync(p).isFile(); } catch { return false; }
    });
    if (!found) {
      throw new AppError('Imported invoice PDF is missing on disk', 410);
    }
    return fs.readFileSync(found);
  }
  const ctx = await buildInvoiceRenderContext(data.invoice, data.lineItems);
  return await pdfService.renderInvoiceToBuffer(ctx);
}

async function renderInvoicePdfFromPayload(payload) {
  const customer = await db('customer_accounts').where({ id: payload.customerAccountId }).first();
  const lineItems = Array.isArray(payload.lineItems) ? payload.lineItems : [];
  // Migration 119 — preview must match the saved-invoice math:
  //   - Compute every row's raw line_total_minor (qty × unit × discount).
  //   - Then resolveParentTotalsFromSubItems rewrites each parent's
  //     line_total to the sum of its priced sub-items (parent's own
  //     unit_price is ignored when any sub-item has a price).
  //   - Net sums TOP-LEVEL items only (parent_position == null).
  // Without these two steps, the preview shows the parent at 0 and
  // double-counts sub-items into net, neither of which matches the
  // values the renderer would produce for the persisted invoice.
  const items = lineItems.map((li, idx) => {
    const qty = ensureNumber(li.quantity, 1);
    const unit = ensureInt(li.unit_price_minor);
    const discount = ensureNumber(li.discount_percent, 0);
    const lineTotal = Math.round(Math.round(qty * unit) * (1 - discount / 100));
    return { ...li, position: li.position || idx + 1, line_total_minor: lineTotal };
  });
  const { resolveParentTotalsFromSubItems } = getHierarchyHelpers();
  resolveParentTotalsFromSubItems(items);
  let netMinor = 0;
  for (const it of items) {
    if (it.parent_position == null || it.parent_position === '') {
      netMinor += ensureInt(it.line_total_minor);
    }
  }
  // Match the saved-invoice math: clean-net reconciliation when the
  // crm_invoice_round_total setting is on (see createInvoice).
  const roundTotal = (await getAppSetting('crm_invoice_round_total', false)) === true;
  if (roundTotal) {
    netMinor = cleanNetMinor(items, { parentKey: 'parent_position', positionKey: 'position' });
  }
  const vatRate = ensureNumber(payload.vatRate, 0);
  const vatMinor = Math.round(netMinor * vatRate / 100);
  const shippingMinor = ensureInt(payload.shippingAmountMinor);
  const totalMinor = netMinor + vatMinor + shippingMinor;
  const fakeInvoice = {
    invoice_number: 'PREVIEW',
    customer_account_id: payload.customerAccountId,
    language: payload.language || customer?.preferred_language || 'de',
    currency: (payload.currency || 'CHF').toUpperCase(),
    issue_date: payload.issueDate || new Date().toISOString().slice(0, 10),
    due_date: payload.dueDate || new Date(Date.now() + 30 * 86400e3).toISOString().slice(0, 10),
    business_bank_account_id: payload.businessBankAccountId,
    qr_format: payload.qrFormat,
    net_amount_minor: netMinor,
    vat_rate: vatRate,
    vat_amount_minor: vatMinor,
    shipping_amount_minor: shippingMinor,
    total_amount_minor: totalMinor,
  };
  const ctx = await buildInvoiceRenderContext(fakeInvoice, items);
  return await pdfService.renderInvoiceToBuffer(ctx);
}
module.exports = {
  buildInvoiceRenderContext,
  renderInvoicePdfBuffer,
  renderInvoicePdfFromPayload,
};
