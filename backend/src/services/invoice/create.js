// Extracted verbatim from invoiceService.js — see ../invoiceService.js for the
// module-level overview. Do not add behavior here without updating the entry re-exports.

const crypto = require('crypto');
const { db, logActivity } = require('../../database/db');
const { getAppSetting } = require('../../utils/appSettings');
const { cleanNetMinor } = require('../../utils/invoiceRounding');
const { AppError } = require('../../utils/errors');
const businessProfileService = require('../businessProfileService');
const { ensureInt, ensureNumber } = require('../../utils/numericHelpers');
const { hasColumnCached } = require('../../utils/schemaCache');
const { computeDueDate, computeScheduledSendAt, ensureCustomerCanBill, getHierarchyHelpers, nextInvoiceNumber, resolveDealUuid, resolveNetDays, snapToNextBillingCycle } = require('./helpers');
const { appendToMonthlyDraft } = require('./drafts');


/**
 * Create one invoice. Returns id. Used both manually (admin creates a
 * standalone invoice) and by scheduleInvoicesForEvent (one per installment).
 */
async function createInvoice(payload, adminId, trx = db) {
  const customer = await trx('customer_accounts').where({ id: payload.customerAccountId }).first();
  ensureCustomerCanBill(customer);

  // PR #603 review follow-up #1 — when an invoice is attached to an event,
  // make sure that event actually belongs to the chosen customer. Without
  // this, a typo'd/copy-pasted eventId silently links the invoice to an
  // unrelated event, producing misleading reporting links. Only enforced
  // when the event HAS customer assignments (an event with none — e.g. a
  // legacy import — is allowed through, since we can't prove a mismatch).
  if (payload.eventId && await trx.schema.hasTable('event_customer_assignments')) {
    const assignments = await trx('event_customer_assignments')
      .where({ event_id: payload.eventId })
      .select('customer_account_id');
    if (assignments.length > 0 &&
        !assignments.some(a => a.customer_account_id === payload.customerAccountId)) {
      throw new AppError('The selected event is not assigned to this customer', 422, 'EVENT_CUSTOMER_MISMATCH');
    }
  }

  // Accumulator intercept (migration 128). For customers in
  // billing_cadence='monthly' OR 'manual' mode every createInvoice call
  // APPENDS line items onto a single running draft instead of minting a
  // fresh invoice. Admin sees the editor flow exactly as before; the
  // returned id is the draft's id so the UI can redirect to the
  // accumulator. The two modes differ only in WHEN the draft ships:
  // 'monthly' auto-flushes on the cadence day (scheduler), 'manual'
  // never auto-flushes (no period_end) and ships only via the admin
  // "Trigger invoice now" gesture. `_skipMonthlyRouting` is the escape
  // hatch used by internal helpers that need to mint a non-draft row
  // (e.g. the accumulator itself, or future test fixtures).
  if ((customer.billing_cadence === 'monthly' || customer.billing_cadence === 'manual')
      && !payload._skipMonthlyRouting) {
    const draft = await appendToMonthlyDraft(payload, customer, adminId, trx);
    return { invoiceIds: draft?.id ? [draft.id] : [] };
  }

  const profile = (await businessProfileService.getProfile()).profile;
  const currency = (payload.currency || profile?.default_currency || 'CHF').toUpperCase();
  const language = payload.language || customer.preferred_language || profile?.default_locale || 'de';

  // Sequence number is claimed BELOW the installment auto-route so a
  // multi-installment save doesn't waste a number. When installments
  // are present, spawnInstallmentInvoices claims one number per
  // sibling and we never reach the single-row insert that would have
  // used `invoiceNumber` here.
  const issueDate = payload.issueDate || new Date().toISOString().slice(0, 10);
  const scheduledSendAt = payload.scheduledSendAt ? new Date(payload.scheduledSendAt) : null;
  // Resolve net_days BEFORE computing the due date so Net 60 / 90
  // selections actually push the due date out. resolveNetDays honors
  // the split picker FK the editor sends, the legacy single FK, and
  // the crm_payment_default_net_days setting (see helper). The clock
  // starts on the SEND date when the invoice is scheduled, otherwise
  // the issue date — so a future send pushes the due date out too.
  const resolvedNetDays = await resolveNetDays(payload, trx);
  const dueDate = payload.dueDate || computeDueDate(scheduledSendAt || new Date(issueDate), resolvedNetDays)
    .toISOString().slice(0, 10);

  // Re-compute totals from line items. Migration 119 — items with a
  // non-null `parent_position` are sub-items and their line totals do
  // NOT roll into net directly. Parent totals AUTO-RESOLVE from
  // priced sub-items: if any sub-item under a parent has unit_price > 0,
  // the parent's effective line_total_minor becomes the sum of those
  // sub-items, and the parent's own stored unit_price is ignored.
  // Mental model matches the editor — pricing on sub-items implies
  // "parent is a header, total derives from what's under it".
  const lineItems = Array.isArray(payload.lineItems) ? payload.lineItems : [];
  const items = lineItems.map((li, idx) => {
    const qty = ensureNumber(li.quantity, 1);
    const unit = ensureInt(li.unit_price_minor);
    const discount = ensureNumber(li.discount_percent, 0);
    const lineTotal = Math.round(Math.round(qty * unit) * (1 - discount / 100));
    const isSubItem = li.parent_position != null && li.parent_position !== '';
    return {
      position: ensureInt(li.position) || (idx + 1),
      quantity: qty,
      description: String(li.description || ''),
      unit_price_minor: unit,
      discount_percent: discount,
      line_total_minor: lineTotal,
      parent_position: isSubItem ? ensureInt(li.parent_position) : null,
      details_text: li.details_text || null,
    };
  });
  // Apply the migration-119 hierarchy resolver: rewrites parent
  // line_total_minor to sum-of-priced-sub-items where applicable.
  // Net is then summed across top-level (resolved) items.
  const { resolveParentTotalsFromSubItems } = getHierarchyHelpers();
  resolveParentTotalsFromSubItems(items);
  let netMinor = 0;
  for (const li of items) {
    if (li.parent_position == null) netMinor += ensureInt(li.line_total_minor);
  }
  // Optional sub-cent reconciliation (crm_invoice_round_total). When on,
  // store the full-precision net rounded ONCE so the total matches
  // qty × unit arithmetic; the per-line rounding drift is surfaced as a
  // "Rundung" row at render time (storedNet − Σ line totals). Off by
  // default ⇒ net stays the sum of rounded lines, unchanged behaviour.
  const roundTotal = (await getAppSetting('crm_invoice_round_total', false)) === true;
  if (roundTotal) {
    netMinor = cleanNetMinor(items, { parentKey: 'parent_position', positionKey: 'position' });
  }
  const vatRate = ensureNumber(payload.vatRate, 0);
  const vatMinor = Math.round(netMinor * vatRate / 100);
  const shippingMinor = ensureInt(payload.shippingAmountMinor);
  const totalMinor = netMinor + vatMinor + shippingMinor;

  // Negative line items (Rabatt) are allowed, but the resulting
  // invoice total must not go below zero. Credit notes belong in
  // the Storno path (createStorno), which mints a separate
  // kind='storno' record with cancels_invoice_id set.
  if (totalMinor < 0) {
    throw new AppError(
      'Invoice total cannot be negative. To issue a credit note, cancel the original invoice with Storno.',
      400,
      'INVOICE_TOTAL_NEGATIVE',
    );
  }

  const bank = await businessProfileService.resolveBankAccountForCurrency(currency, payload.businessBankAccountId);

  // Snapshot the selected payment-term template (net days / Skonto /
  // installment plan) onto the invoice itself. Mirrors how the quote
  // editor handles this — once snapshotted, edits to the template
  // don't retroactively change rendered invoices. Migration 113.
  let paymentTermTemplateId = null;
  let paymentTermSnapshot = null;
  let paymentNetDaysTemplateId = null;
  let paymentTimingTemplateId = null;
  // Migration 124 — prefer the two split FKs. Compose a snapshot from
  // them in the same shape pdfService + scheduler already consume.
  // Fall back to the legacy single FK when the caller still uses it.
  if (payload.paymentNetDaysTemplateId && payload.paymentTimingTemplateId) {
    const [netDays, timing] = await Promise.all([
      trx('payment_net_days_templates').where({ id: payload.paymentNetDaysTemplateId }).first(),
      trx('payment_timing_templates').where({ id: payload.paymentTimingTemplateId }).first(),
    ]);
    if (netDays && timing) {
      paymentNetDaysTemplateId = netDays.id;
      paymentTimingTemplateId = timing.id;
      paymentTermSnapshot = JSON.stringify({
        description: timing.description || netDays.description || null,
        net_days: netDays.net_days,
        skonto_percent: netDays.skonto_percent,
        skonto_within_days: netDays.skonto_within_days,
        installments: typeof timing.installments === 'string'
          ? (() => { try { return JSON.parse(timing.installments); } catch { return null; } })()
          : timing.installments || null,
      });
    }
  } else if (payload.paymentTermTemplateId) {
    const tpl = await trx('payment_term_templates')
      .where({ id: payload.paymentTermTemplateId }).first();
    if (tpl) {
      paymentTermTemplateId = tpl.id;
      paymentTermSnapshot = JSON.stringify({
        description: tpl.description || null,
        net_days: tpl.net_days,
        skonto_percent: tpl.skonto_percent,
        skonto_within_days: tpl.skonto_within_days,
        installments: typeof tpl.installments === 'string'
          ? (() => { try { return JSON.parse(tpl.installments); } catch { return null; } })()
          : tpl.installments || null,
      });
    }
  }

  // Multi-installment auto-route. Priority:
  //   1. payload.installments  (explicit override from the ad-hoc
  //      editor panel — wins over any saved template)
  //   2. snapshot.installments (loaded from the picked payment-timing
  //      template above)
  // If either yields ≥2 entries we delegate to spawnInstallmentInvoices
  // (the same loop used by quote→invoice conversion) and return the
  // array of created IDs. Single-installment plans fall through to
  // the single-row insert below.
  let installmentsForSpawn = null;
  if (Array.isArray(payload.installments) && payload.installments.length > 1) {
    installmentsForSpawn = payload.installments;
  } else if (paymentTermSnapshot) {
    const parsedSnap = typeof paymentTermSnapshot === 'string'
      ? (() => { try { return JSON.parse(paymentTermSnapshot); } catch { return null; } })()
      : paymentTermSnapshot;
    if (parsedSnap && Array.isArray(parsedSnap.installments) && parsedSnap.installments.length > 1) {
      installmentsForSpawn = parsedSnap.installments;
    }
  }
  if (installmentsForSpawn) {
    return await spawnInstallmentInvoices({
      trx,
      eventId: payload.eventId || null,
      quoteId: payload.sourceQuoteId || null,
      customer,
      currency,
      language,
      lineItems: items,
      totals: {
        net: netMinor,
        vatRate,
        vat: vatMinor,
        shipping: shippingMinor,
        total: totalMinor,
      },
      installments: installmentsForSpawn,
      eventDate: payload.eventDate || null,
      adminId,
      ccPdfEmail: payload.ccPdfEmail || null,
      netDays: resolvedNetDays,
      eventName: payload.eventName || null,
      eventTimeStart: payload.eventTimeStart || null,
      eventTimeEnd: payload.eventTimeEnd || null,
      paymentNetDaysTemplateId,
      paymentTimingTemplateId,
      paymentTermSnapshot,
      dealUuid: await resolveDealUuid(trx, payload),
    });
  }

  // Claim the sequence number HERE — after the installment auto-route
  // has been ruled out. Previously this was at the top of the function
  // which leaked one number per multi-installment save (the spawner
  // claims its own numbers and never used this one).
  // Pass trx so the sequence claim joins our outer transaction —
  // SQLite deadlocks otherwise (1-connection default).
  const invoiceNumber = await nextInvoiceNumber(trx);
  const row = {
    invoice_number: invoiceNumber,
    customer_account_id: payload.customerAccountId,
    source_quote_id: payload.sourceQuoteId || null,
    event_id: payload.eventId || null,
    // Inline event snapshot (migration 123). Mirrors quotes — the
    // snapshot survives an event rename so an archived invoice keeps
    // its original event label for accounting / audit. Optional;
    // standalone invoices created without an event will have these
    // as null and the renderer simply omits the for-clause.
    event_name: payload.eventName || null,
    event_date: payload.eventDate || null,
    event_time_start: payload.eventTimeStart || null,
    event_time_end: payload.eventTimeEnd || null,
    language,
    currency,
    issue_date: issueDate,
    due_date: dueDate,
    installment_index: ensureInt(payload.installmentIndex),
    installment_total: ensureInt(payload.installmentTotal) || 1,
    installment_label: payload.installmentLabel || null,
    installment_trigger: payload.installmentTrigger || null,
    status: scheduledSendAt && scheduledSendAt.getTime() > Date.now() ? 'scheduled' : (payload.sendNow ? 'scheduled' : 'scheduled'),
    scheduled_send_at: scheduledSendAt,
    net_amount_minor: netMinor,
    vat_rate: vatRate,
    vat_amount_minor: vatMinor,
    shipping_amount_minor: shippingMinor,
    total_amount_minor: totalMinor,
    cc_pdf_email: payload.ccPdfEmail || null,
    business_bank_account_id: bank?.id || null,
    qr_format: payload.qrFormat || null,
    payment_term_template_id: paymentTermTemplateId,
    payment_net_days_template_id: paymentNetDaysTemplateId,
    payment_timing_template_id: paymentTimingTemplateId,
    payment_term_snapshot: paymentTermSnapshot,
    // Per-invoice Skonto opt-out (migration 126). Defaults to false
    // — invoice inherits the snapshot/global Skonto config unless
    // admin explicitly ticks "Disable Skonto" in the editor.
    skonto_disabled: Boolean(payload.skontoDisabled),
    // Migration 140 — deal_uuid lineage. Priority: explicit payload
    // (used by spawnInstallmentInvoices and Storno/reissue callers to
    // force a specific value), source quote, source contract,
    // otherwise fresh mint.
    deal_uuid: await resolveDealUuid(trx, payload),
    created_by_admin_id: adminId,
    created_at: new Date(),
    updated_at: new Date(),
  };
  // Migration 130 — snapshot the chosen output VAT code (immutable; the
  // accounting export emits exactly this rather than re-deriving from the map).
  if (payload.vatCode !== undefined && await hasColumnCached('invoices', 'vat_code')) {
    row.vat_code = payload.vatCode ? String(payload.vatCode).slice(0, 16) : null;
  }
  const inserted = await trx('invoices').insert(row).returning('id');
  const invoiceId = typeof inserted[0] === 'object' ? inserted[0].id : inserted[0];

  if (items.length > 0) {
    const { validateLineItemHierarchy, insertLineItemsHierarchical } = getHierarchyHelpers();
    validateLineItemHierarchy(items);
    await insertLineItemsHierarchical(trx, 'invoice_line_items', 'invoice_id', invoiceId, items);
  }

  try { await logActivity('invoice_created', { invoiceId, invoiceNumber }, payload.eventId || null, `admin:${adminId}`); } catch (_) {}
  return { invoiceIds: [invoiceId] };
}

/**
 * Fan-out helper. Creates one invoice row per installment with the
 * right `scheduled_send_at`, sequential invoice numbers, and per-
 * slice totals. Used by:
 *
 *   - quoteService.convertToEvent / convertToInvoiceOnly — quote
 *     conversion with multi-installment payment plans.
 *   - createInvoice (this file) — when the standalone editor path
 *     submits an installment array.
 *
 * Expects to be called inside an existing transaction.
 *
 * Returns `{ invoiceIds: number[] }` — ordered by installment_index
 * so callers can navigate to the first or report N IDs.
 *
 * The legacy export name `scheduleInvoicesForEvent` is preserved as
 * an alias for backward compatibility with quoteService callers; new
 * code should reach for the clearer `spawnInstallmentInvoices`.
 */
async function spawnInstallmentInvoices({ trx, eventId, quoteId, customer, currency, language,
  lineItems, totals, installments, eventDate, adminId,
  ccPdfEmail, netDays,
  eventName, eventTimeStart, eventTimeEnd,
  paymentNetDaysTemplateId, paymentTimingTemplateId,
  paymentTermSnapshot, dealUuid, hold = false }) {
  // Monthly-billing intercept (migration 128). Quote → invoice
  // conversion for a monthly-mode customer doesn't fan out N
  // installment invoices — the customer pays one consolidated bill
  // per period. Append the line items to the running draft (creating
  // it if needed) and return early. The installment / cadence math
  // below is bypassed; the quote's payment timing is irrelevant once
  // items flow into the monthly accumulator.
  if (customer && customer.billing_cadence === 'monthly') {
    const draft = await appendToMonthlyDraft({
      customerAccountId: customer.id,
      lineItems: (lineItems || []).map((li) => ({
        position: li.position,
        quantity: li.quantity,
        unit_price_minor: li.unit_price_minor,
        discount_percent: li.discount_percent,
        description: li.description,
        parent_position: li.parent_position,
        details_text: li.details_text,
      })),
      vatRate: totals?.vatRate,
    }, customer, adminId, trx);
    return { invoiceIds: draft?.id ? [draft.id] : [] };
  }

  // netDays drives the due-date offset on every scheduled invoice
  // created here. Callers in quoteService pass the converting quote's
  // payment-term net_days so Net 60 / 90 templates flow through; when
  // absent we fall back to the crm_payment_default_net_days setting
  // (then 30) rather than silently using 30, matching createInvoice.
  const resolvedNetDays = ensureInt(netDays)
    || ensureInt(await getAppSetting('crm_payment_default_net_days', null, trx || db))
    || 30;
  const total = installments.length;
  const acceptanceTime = new Date();
  const invoiceIds = [];

  for (let i = 0; i < total; i++) {
    const inst = installments[i];
    const percent = ensureNumber(inst.percent, 0);
    if (percent <= 0) continue;

    // Each installment carries its own slice of the totals. Round to
    // minor units; last installment absorbs rounding drift so the
    // total exactly equals the quote total.
    let netSlice, vatSlice, shippingSlice, totalSlice;
    if (i === total - 1) {
      // We computed everything so far; remaining slice closes the gap.
      const accNet = installments.slice(0, i).reduce((s, x) => s + Math.round(ensureInt(totals.net) * ensureNumber(x.percent, 0) / 100), 0);
      const accVat = installments.slice(0, i).reduce((s, x) => s + Math.round(ensureInt(totals.vat) * ensureNumber(x.percent, 0) / 100), 0);
      const accShipping = installments.slice(0, i).reduce((s, x) => s + Math.round(ensureInt(totals.shipping) * ensureNumber(x.percent, 0) / 100), 0);
      const accTotal = installments.slice(0, i).reduce((s, x) => s + Math.round(ensureInt(totals.total) * ensureNumber(x.percent, 0) / 100), 0);
      netSlice = ensureInt(totals.net) - accNet;
      vatSlice = ensureInt(totals.vat) - accVat;
      shippingSlice = ensureInt(totals.shipping) - accShipping;
      totalSlice = ensureInt(totals.total) - accTotal;
    } else {
      netSlice = Math.round(ensureInt(totals.net) * percent / 100);
      vatSlice = Math.round(ensureInt(totals.vat) * percent / 100);
      shippingSlice = Math.round(ensureInt(totals.shipping) * percent / 100);
      totalSlice = Math.round(ensureInt(totals.total) * percent / 100);
    }

    let scheduledSendAt = computeScheduledSendAt(inst.trigger, inst.offset_days, eventDate, acceptanceTime);
    // Per-customer billing cadence override: monthly / quarterly
    // customers don't pay per-event — snap to the next period boundary.
    if (customer && customer.billing_cadence && customer.billing_cadence !== 'per_event') {
      scheduledSendAt = snapToNextBillingCycle(scheduledSendAt, customer.billing_cadence, customer.billing_cycle_day);
    }

    // `after_delivery` invoices wait for the admin to confirm photos
    // have actually been delivered before they fire — we can't infer
    // that automatically from a date. Mark them `pending_delivery`
    // with no scheduled_send_at; the scheduler only picks rows in
    // status `scheduled`, so they sit idle until the admin clicks
    // "Release for delivery" on the invoice detail page.
    const isDeliveryTrigger = inst.trigger === 'after_delivery';
    // `hold` (workflow draft-seam): the booking flow's review gate + explicit
    // send_document IS the release, so a held invoice is always `scheduled`
    // (editable + sendable via sendInvoice) regardless of trigger — never
    // `pending_delivery`, which sendInvoice refuses. Without hold, an
    // after_delivery invoice stays `pending_delivery` as before.
    const rowStatus = (isDeliveryTrigger && !hold) ? 'pending_delivery' : 'scheduled';
    // Held invoices carry no scheduled_send_at so the scheduler never auto-sends
    // them — they wait for send_document. after_delivery rows are likewise null
    // (the scheduler can't infer a delivery date).
    const rowScheduledSendAt = (isDeliveryTrigger || hold) ? null : scheduledSendAt;

    const invoiceNumber = await nextInvoiceNumber(trx);
    const dueDate = computeDueDate(scheduledSendAt, resolvedNetDays).toISOString().slice(0, 10);

    const row = {
      invoice_number: invoiceNumber,
      customer_account_id: customer.id,
      source_quote_id: quoteId,
      event_id: eventId,
      // Inline event snapshot carried over from the source quote
      // (migration 123). Mirrors how event_date is already carried —
      // a converted invoice should keep the event reference even if
      // the linked event is later renamed or deleted.
      event_name: eventName || null,
      event_date: eventDate || null,
      event_time_start: eventTimeStart || null,
      event_time_end: eventTimeEnd || null,
      language,
      currency,
      issue_date: scheduledSendAt.toISOString().slice(0, 10),
      due_date: dueDate,
      installment_index: i,
      installment_total: total,
      installment_label: inst.label || `Installment ${i + 1}/${total}`,
      installment_trigger: inst.trigger,
      status: rowStatus,
      scheduled_send_at: rowScheduledSendAt,
      net_amount_minor: netSlice,
      vat_rate: ensureNumber(totals.vatRate, 0),
      vat_amount_minor: vatSlice,
      shipping_amount_minor: shippingSlice,
      total_amount_minor: totalSlice,
      cc_pdf_email: ccPdfEmail || null,
      // Migration 124 — carry the split payment-term FKs over from
      // the source quote so the converted invoice is editable (when
      // it eventually unlocks) with the same orthogonal split. The
      // snapshot itself is the legal record; the FKs are convenience.
      payment_net_days_template_id: paymentNetDaysTemplateId || null,
      payment_timing_template_id: paymentTimingTemplateId || null,
      payment_term_snapshot: paymentTermSnapshot
        ? (typeof paymentTermSnapshot === 'string'
          ? paymentTermSnapshot
          : JSON.stringify(paymentTermSnapshot))
        : null,
      // Migration 140 — every installment sibling shares one deal_uuid
      // (passed in from the converting caller, ultimately the source
      // quote's value). Defensive fallback to a fresh UUID if the
      // caller didn't pass one — shouldn't happen on a migrated
      // install but keeps the column non-null.
      deal_uuid: dealUuid || crypto.randomUUID(),
      created_by_admin_id: adminId,
      created_at: new Date(),
      updated_at: new Date(),
    };

    const inserted = await trx('invoices').insert(row).returning('id');
    const invoiceId = typeof inserted[0] === 'object' ? inserted[0].id : inserted[0];

    // Line items: copy from the quote so the customer sees what they
    // actually agreed to, not a generic "Gesamtbetrag" placeholder.
    // Two modes:
    //   - Single-installment (100%): clone every quote line item
    //     verbatim. The invoice totals already match the quote's.
    //   - Multi-installment (split payment): clone the quote lines
    //     but mark the invoice with the installment context. We pro-
    //     rate by inserting one extra line at the bottom that adjusts
    //     to the installment slice — keeps the per-line description
    //     visible while the total still equals the pro-rata amount.
    const sourceLines = Array.isArray(lineItems) ? lineItems : [];
    if (sourceLines.length === 0) {
      // Fallback for the (rare) case where the quote has no line
      // items — fall back to the legacy "Installment N/M" line so
      // we still produce a sensible invoice.
      await trx('invoice_line_items').insert({
        invoice_id: invoiceId,
        position: 1,
        quantity: 1,
        description: inst.label || `Installment ${i + 1}/${total}`,
        unit_price_minor: netSlice,
        discount_percent: 0,
        line_total_minor: netSlice,
        created_at: new Date(),
        updated_at: new Date(),
      });
    } else {
      // Clone each quote line as-is, preserving its original `position`
      // so the sub-item hierarchy carries over. Source lines already
      // have `parent_position` populated by getQuoteById's self-join,
      // so the same value reused on the new invoice points at the
      // correct (also-cloned) parent. insertLineItemsHierarchical
      // resolves position → new parent_line_item_id during the
      // two-phase insert. Migration 119.
      const cloned = sourceLines.map((li) => ({
        position: ensureInt(li.position),
        quantity: li.quantity,
        description: li.description,
        unit_price_minor: ensureInt(li.unit_price_minor),
        discount_percent: ensureNumber(li.discount_percent, 0),
        line_total_minor: ensureInt(li.line_total_minor),
        parent_position: li.parent_position == null ? null : ensureInt(li.parent_position),
        details_text: li.details_text || null,
      }));
      const { validateLineItemHierarchy, insertLineItemsHierarchical } = getHierarchyHelpers();
      validateLineItemHierarchy(cloned);
      await insertLineItemsHierarchical(trx, 'invoice_line_items', 'invoice_id', invoiceId, cloned);

      // For split payments add an explicit "Installment X/Y (Z%)"
      // adjustment line that reconciles the cloned line totals to
      // the actual invoice net (which is the pro-rata slice). The
      // line carries the difference as a negative if the slice is
      // less than the quote total (typical), or positive on the
      // final installment if rounding nudged the other way.
      //
      // The adjustment ONLY considers top-level cloned lines —
      // sub-items don't contribute to net so they can't appear in
      // the reconciliation sum.
      if (total > 1) {
        const clonedSum = cloned
          .filter((x) => x.parent_position == null)
          .reduce((s, x) => s + ensureInt(x.line_total_minor), 0);
        const adjustment = netSlice - clonedSum;
        if (adjustment !== 0) {
          const installmentLabel = inst.label || `Installment ${i + 1}/${total}`;
          const maxPosition = cloned.reduce((m, x) => Math.max(m, x.position), 0);
          await trx('invoice_line_items').insert({
            invoice_id: invoiceId,
            position: maxPosition + 1,
            quantity: 1,
            description: `${installmentLabel} (${percent}% — ${i + 1}/${total})`,
            unit_price_minor: adjustment,
            discount_percent: 0,
            line_total_minor: adjustment,
            parent_line_item_id: null,
            details_text: null,
            created_at: new Date(),
            updated_at: new Date(),
          });
        }
      }
    }

    try {
      // Pass `trx` so the audit insert rides the transaction's connection —
      // logging via the global db here deadlocks the single-connection SQLite
      // pool (this runs unattended from the booking flow's prepare_invoice).
      await logActivity('invoice_scheduled', { invoiceId, invoiceNumber, eventId, quoteId, scheduledSendAt },
        eventId, `admin:${adminId}`, trx);
    } catch (_) {}
    invoiceIds.push(invoiceId);
  }
  return { invoiceIds };
}

// Backward-compat alias — older callers reference this name.
const scheduleInvoicesForEvent = spawnInstallmentInvoices;
module.exports = {
  createInvoice,
  spawnInstallmentInvoices,
  scheduleInvoicesForEvent,
};
