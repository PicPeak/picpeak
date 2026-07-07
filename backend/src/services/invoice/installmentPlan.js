// Extracted verbatim from invoiceService.js — see ../invoiceService.js for the
// module-level overview. Do not add behavior here without updating the entry re-exports.

const { logActivity } = require('../../database/db');
const { AppError } = require('../../utils/errors');
const { ensureInt, ensureNumber } = require('../../utils/numericHelpers');
const { computeDueDate, computeScheduledSendAt, EDITABLE_INSTALLMENT_STATUSES, getHierarchyHelpers, nextInvoiceNumber, snapToNextBillingCycle, VALID_INSTALLMENT_TRIGGERS } = require('./helpers');


/**
 * Compute one slice of a plan total. Matches the rounding rule used by
 * spawnInstallmentInvoices — every slice except the last is a rounded
 * percent share; the last slice absorbs rounding drift so the per-slice
 * sums exactly equal the plan total.
 */
function computeSliceTotals(installments, totals, i) {
  const lastIndex = installments.length - 1;
  const pct = ensureNumber(installments[i].percent, 0);
  if (i < lastIndex) {
    return {
      net: Math.round(ensureInt(totals.net) * pct / 100),
      vat: Math.round(ensureInt(totals.vat) * pct / 100),
      shipping: Math.round(ensureInt(totals.shipping) * pct / 100),
      total: Math.round(ensureInt(totals.total) * pct / 100),
    };
  }
  const acc = installments.slice(0, i).reduce((s, x) => {
    const p = ensureNumber(x.percent, 0);
    return {
      net: s.net + Math.round(ensureInt(totals.net) * p / 100),
      vat: s.vat + Math.round(ensureInt(totals.vat) * p / 100),
      shipping: s.shipping + Math.round(ensureInt(totals.shipping) * p / 100),
      total: s.total + Math.round(ensureInt(totals.total) * p / 100),
    };
  }, { net: 0, vat: 0, shipping: 0, total: 0 });
  return {
    net: ensureInt(totals.net) - acc.net,
    vat: ensureInt(totals.vat) - acc.vat,
    shipping: ensureInt(totals.shipping) - acc.shipping,
    total: ensureInt(totals.total) - acc.total,
  };
}

/**
 * Throws AppError on invalid input. Exposed for the route layer to
 * surface as 400 before opening a transaction.
 */
function validateInstallmentPlanInput(installments) {
  if (!Array.isArray(installments) || installments.length === 0) {
    throw new AppError('installments must be a non-empty array', 400);
  }
  let sum = 0;
  for (let i = 0; i < installments.length; i++) {
    const inst = installments[i] || {};
    const pct = ensureNumber(inst.percent, NaN);
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
      throw new AppError(`Row ${i + 1}: percent must be between 0 and 100`, 400);
    }
    if (!VALID_INSTALLMENT_TRIGGERS.has(inst.trigger)) {
      throw new AppError(`Row ${i + 1}: invalid trigger '${inst.trigger}'`, 400);
    }
    const off = ensureInt(inst.offset_days);
    if (!Number.isFinite(off)) {
      throw new AppError(`Row ${i + 1}: offset_days must be an integer`, 400);
    }
    sum += pct;
  }
  if (Math.abs(sum - 100) > 0.001) {
    throw new AppError(
      `Installment percents must sum to 100 (got ${sum})`,
      400,
      'PERCENT_SUM_INVALID',
    );
  }
}

/**
 * Heuristic — spawnInstallmentInvoices appends a reconciliation line
 * with a stable description shape like "Anzahlung (30% — 1/3)". The
 * em-dash is U+2014 so the regex won't match plain hyphens used in
 * admin-authored line descriptions.
 *
 * We could harden this with an `is_reconciliation_line` column, but
 * the cost of a schema change isn't worth the residual edge (admins
 * don't edit reconciliation lines today).
 */
function isReconciliationLineItem(li) {
  if (!li || typeof li.description !== 'string') return false;
  return / \(\d+(?:\.\d+)?% — \d+\/\d+\)$/.test(li.description);
}

/**
 * Replace (or insert) the reconciliation line on an invoice so its
 * description matches the new label/percent and the line's amount
 * closes the gap between the cloned-quote-line subtotal and the
 * sibling's net slice. Symmetric with the inline logic in spawn.
 *
 * `topLineSubtotal` is the sum of non-reconciliation, top-level line
 * items already on the invoice — passed in so callers reading the row
 * once don't have to re-query.
 */
async function replaceReconciliationLine(
  trx, invoiceId, { label, percent, index, total, netSlice, topLineSubtotal },
) {
  const all = await trx('invoice_line_items')
    .where({ invoice_id: invoiceId })
    .orderBy('position', 'asc');
  for (const li of all) {
    if (isReconciliationLineItem(li)) {
      await trx('invoice_line_items').where({ id: li.id }).del();
    }
  }
  if (total <= 1) return;

  const nonRecon = all.filter((x) => !isReconciliationLineItem(x));
  const subtotal = topLineSubtotal != null
    ? topLineSubtotal
    : nonRecon.filter((x) => x.parent_position == null)
      .reduce((s, x) => s + ensureInt(x.line_total_minor), 0);
  const adjustment = netSlice - subtotal;
  if (adjustment === 0) return;

  const maxPosition = nonRecon.reduce(
    (m, x) => Math.max(m, ensureInt(x.position)), 0,
  );
  await trx('invoice_line_items').insert({
    invoice_id: invoiceId,
    position: maxPosition + 1,
    quantity: 1,
    description: `${label} (${percent}% — ${index + 1}/${total})`,
    unit_price_minor: adjustment,
    discount_percent: 0,
    line_total_minor: adjustment,
    parent_line_item_id: null,
    details_text: null,
    created_at: new Date(),
    updated_at: new Date(),
  });
}

/**
 * Atomically reshape an installment plan after siblings have spawned.
 * The plan is the unit of edit: percents / count / triggers all change
 * together in one transaction. Mutating individual siblings stays on
 * the existing PUT /admin/invoices/:id path.
 *
 * Guards:
 *   - dealUuid must exist + own ≥1 invoice (else 404)
 *   - all siblings must be in EDITABLE_INSTALLMENT_STATUSES (else 409
 *     `INVOICE_LOCKED`)
 *   - no Storno on the deal (else 409 `PLAN_HAS_STORNO`)
 *   - new plan validated by validateInstallmentPlanInput
 *
 * Algorithm:
 *   - Plan total = sum of existing siblings' totals (captures any
 *     per-sibling edits since spawn).
 *   - Reused siblings (i < min(old, new)): UPDATE in place — preserves
 *     id + invoice_number, so sequence numbers aren't burned.
 *   - Extra new rows (new > old): INSERT — claims a fresh invoice_number
 *     per row; clones canonical (non-reconciliation) line items from
 *     existing[0] so each new sibling carries the quote lines.
 *   - Trim rows (new < old): DELETE — claimed sequence numbers ARE lost
 *     (document_sequences has no release path, and that's intentional
 *     for §14 UStG continuity).
 *
 * Returns `{ invoiceIds, kept, created, deleted }`.
 */
async function updateInstallmentPlan({ trx, dealUuid, installments, adminId }) {
  if (!dealUuid) throw new AppError('dealUuid is required', 400);
  validateInstallmentPlanInput(installments);

  const existing = await trx('invoices')
    .where({ deal_uuid: dealUuid })
    .orderBy('installment_index', 'asc');

  if (existing.length === 0) {
    throw new AppError('No invoices found for this deal', 404);
  }
  const isMultiInstallment = existing.some((r) => ensureInt(r.installment_total) > 1);
  if (!isMultiInstallment) {
    throw new AppError(
      'This deal is not an installment plan',
      400,
      'NOT_INSTALLMENT_PLAN',
    );
  }
  for (const row of existing) {
    if (row.kind === 'storno') {
      throw new AppError(
        `Plan contains a Storno (${row.invoice_number}) — reshape refused`,
        409,
        'PLAN_HAS_STORNO',
      );
    }
    if (!EDITABLE_INSTALLMENT_STATUSES.has(row.status)) {
      throw new AppError(
        `Cannot reshape — invoice ${row.invoice_number} is '${row.status}'`,
        409,
        'INVOICE_LOCKED',
      );
    }
  }

  const totals = existing.reduce((acc, r) => ({
    net: acc.net + ensureInt(r.net_amount_minor),
    vat: acc.vat + ensureInt(r.vat_amount_minor),
    shipping: acc.shipping + ensureInt(r.shipping_amount_minor),
    total: acc.total + ensureInt(r.total_amount_minor),
    vatRate: ensureNumber(r.vat_rate, acc.vatRate),
  }), { net: 0, vat: 0, shipping: 0, total: 0, vatRate: 0 });

  const sample = existing[0]; // canonical event + customer + payment-term shape

  // netDays inferred from sample's issue → due gap so the new rows
  // honour the same payment-term the customer agreed to. Falls back
  // to 30 when either column is missing.
  const inferredNetDays = sample.due_date && sample.issue_date
    ? Math.round((new Date(sample.due_date) - new Date(sample.issue_date)) / (24 * 60 * 60 * 1000))
    : 30;
  const netDays = Number.isFinite(inferredNetDays) && inferredNetDays > 0 ? inferredNetDays : 30;

  const eventDate = sample.event_date || null;
  const customer = sample.customer_account_id
    ? await trx('customer_accounts').where({ id: sample.customer_account_id }).first()
    : null;

  // Cache canonical (non-reconciliation) line items from existing[0]
  // for cloning into any newly-created siblings.
  let canonicalLineItems = null;
  const acceptanceTime = new Date();
  const newCount = installments.length;
  const reusableCount = Math.min(existing.length, newCount);

  const kept = [];
  const created = [];
  const deleted = [];

  for (let i = 0; i < newCount; i++) {
    const inst = installments[i];
    const slice = computeSliceTotals(installments, totals, i);

    let scheduledSendAt = computeScheduledSendAt(
      inst.trigger, inst.offset_days, eventDate, acceptanceTime,
    );
    if (customer && customer.billing_cadence && customer.billing_cadence !== 'per_event') {
      scheduledSendAt = snapToNextBillingCycle(
        scheduledSendAt, customer.billing_cadence, customer.billing_cycle_day,
      );
    }
    const isDeliveryTrigger = inst.trigger === 'after_delivery';
    const rowStatus = isDeliveryTrigger ? 'pending_delivery' : 'scheduled';
    const rowScheduledSendAt = isDeliveryTrigger ? null : scheduledSendAt;
    const dueDate = computeDueDate(scheduledSendAt, netDays).toISOString().slice(0, 10);
    const label = inst.label || `Installment ${i + 1}/${newCount}`;

    if (i < reusableCount) {
      const existingRow = existing[i];
      await trx('invoices').where({ id: existingRow.id }).update({
        installment_index: i,
        installment_total: newCount,
        installment_label: label,
        installment_trigger: inst.trigger,
        status: rowStatus,
        scheduled_send_at: rowScheduledSendAt,
        issue_date: scheduledSendAt.toISOString().slice(0, 10),
        due_date: dueDate,
        net_amount_minor: slice.net,
        vat_amount_minor: slice.vat,
        shipping_amount_minor: slice.shipping,
        total_amount_minor: slice.total,
        updated_at: new Date(),
      });
      await replaceReconciliationLine(trx, existingRow.id, {
        label, percent: inst.percent, index: i, total: newCount, netSlice: slice.net,
      });
      kept.push(existingRow.id);
      continue;
    }

    // New sibling — clone canonical lines from existing[0] on first
    // use, then reuse the cached copy for any further new siblings.
    if (canonicalLineItems === null) {
      const sourceLines = await trx('invoice_line_items')
        .where({ invoice_id: existing[0].id })
        .orderBy('position', 'asc');
      canonicalLineItems = sourceLines.filter((li) => !isReconciliationLineItem(li));
    }

    const invoiceNumber = await nextInvoiceNumber(trx);
    const row = {
      invoice_number: invoiceNumber,
      customer_account_id: sample.customer_account_id,
      source_quote_id: sample.source_quote_id,
      event_id: sample.event_id,
      event_name: sample.event_name,
      event_date: sample.event_date,
      event_time_start: sample.event_time_start,
      event_time_end: sample.event_time_end,
      language: sample.language,
      currency: sample.currency,
      issue_date: scheduledSendAt.toISOString().slice(0, 10),
      due_date: dueDate,
      installment_index: i,
      installment_total: newCount,
      installment_label: label,
      installment_trigger: inst.trigger,
      status: rowStatus,
      scheduled_send_at: rowScheduledSendAt,
      net_amount_minor: slice.net,
      vat_rate: ensureNumber(sample.vat_rate, 0),
      vat_amount_minor: slice.vat,
      shipping_amount_minor: slice.shipping,
      total_amount_minor: slice.total,
      cc_pdf_email: sample.cc_pdf_email || null,
      payment_net_days_template_id: sample.payment_net_days_template_id || null,
      payment_timing_template_id: sample.payment_timing_template_id || null,
      payment_term_snapshot: sample.payment_term_snapshot || null,
      deal_uuid: dealUuid,
      created_by_admin_id: adminId,
      created_at: new Date(),
      updated_at: new Date(),
    };
    const inserted = await trx('invoices').insert(row).returning('id');
    const newId = typeof inserted[0] === 'object' ? inserted[0].id : inserted[0];

    if (canonicalLineItems.length > 0) {
      const cloned = canonicalLineItems.map((li) => ({
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
      await insertLineItemsHierarchical(trx, 'invoice_line_items', 'invoice_id', newId, cloned);
    }

    await replaceReconciliationLine(trx, newId, {
      label, percent: inst.percent, index: i, total: newCount, netSlice: slice.net,
    });

    try {
      await logActivity('invoice_scheduled', {
        invoiceId: newId, invoiceNumber, eventId: sample.event_id, source: 'plan_reshape',
      }, sample.event_id, `admin:${adminId}`);
    } catch (_) {}

    created.push(newId);
  }

  // Trim extras (only fires when newCount < existing.length).
  for (let i = newCount; i < existing.length; i++) {
    const oldRow = existing[i];
    await trx('invoice_line_items').where({ invoice_id: oldRow.id }).del();
    await trx('invoices').where({ id: oldRow.id }).del();
    deleted.push(oldRow.id);
  }

  try {
    await logActivity('installment_plan_updated', {
      dealUuid, newCount,
      kept: kept.length, created: created.length, deleted: deleted.length,
    }, sample.event_id, `admin:${adminId}`);
  } catch (_) {}

  return {
    invoiceIds: [...kept, ...created],
    kept, created, deleted,
  };
}
module.exports = {
  computeSliceTotals,
  validateInstallmentPlanInput,
  isReconciliationLineItem,
  replaceReconciliationLine,
  updateInstallmentPlan,
};
