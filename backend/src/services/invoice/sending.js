// Extracted verbatim from invoiceService.js — see ../invoiceService.js for the
// module-level overview. Do not add behavior here without updating the entry re-exports.

const crypto = require('crypto');
const { db, logActivity } = require('../../database/db');
const logger = require('../../utils/logger');
const { AppError } = require('../../utils/errors');
const { formatShortDate } = require('../../utils/dateFormatter');
const { resolveBillingRecipients } = require('../_billingRecipients');
const pdfService = require('../pdfService');
const emailProcessor = require('../emailProcessor');
const { ensureInt, ensureNumber } = require('../../utils/numericHelpers');
const { computeDueDate, ensureCustomerCanBill, formatMajor, getHierarchyHelpers, nextInvoiceNumber, resolveNetDaysForRow } = require('./helpers');
const { getInvoiceById } = require('./queries');
const { createInvoice } = require('./create');
const { buildInvoiceRenderContext } = require('./render');


/**
 * Send an invoice email + PDF. Flips status scheduled → sent.
 */
async function sendInvoice(id, adminId) {
  const data = await getInvoiceById(id);
  if (!data) throw new AppError('Invoice not found', 404);
  const { invoice, lineItems } = data;
  // Stornorechnungen go through their own send path — different
  // email template, different variables, different PDF render
  // branch. The scheduler's flush loop hits this entry point for
  // every row in status='scheduled', so the dispatch lives here.
  if (invoice.kind === 'storno') {
    return await sendStorno(id, adminId);
  }
  if (!['scheduled', 'sent', 'overdue'].includes(invoice.status)) {
    throw new AppError(`Cannot send invoice with status '${invoice.status}'`, 409);
  }
  // Monthly-draft guard (migration 128). Rows flagged
  // is_monthly_draft=true accumulate line items across the period
  // and must ONLY be issued via triggerMonthlyBillNow / the scheduled
  // monthly flush — both clear the flag before re-entering this
  // function. Without this guard, admin clicks on a draft's Send
  // button would ship the running accumulator early AND leave the
  // flag set, so subsequent createInvoice calls would silently
  // append onto the same already-sent row.
  if (invoice.is_monthly_draft === true || invoice.is_monthly_draft === 1) {
    throw new AppError(
      'This invoice is a monthly draft — use "Trigger invoice now" on the customer detail page, or wait for the scheduled cycle day.',
      409, 'MONTHLY_DRAFT_NOT_SENDABLE',
    );
  }
  const customer = await db('customer_accounts').where({ id: invoice.customer_account_id }).first();
  ensureCustomerCanBill(customer);

  // Re-sync the invoice's language from the customer's current
  // preferred_language at send time when the invoice has never been
  // sent. Picks up admin language changes made between create and
  // send (notable for monthly drafts that accumulate for ~30 days,
  // and for any standalone scheduled invoice where admin updated the
  // customer record after authoring). Sent / overdue invoices keep
  // their existing language because they're legal records — the
  // rendered PDF is the source of truth from the moment it ships.
  if (invoice.status === 'scheduled' && customer.preferred_language
      && customer.preferred_language !== invoice.language) {
    await db('invoices').where({ id }).update({
      language: customer.preferred_language,
      updated_at: new Date(),
    });
    invoice.language = customer.preferred_language;
  }

  // Stamp the issue date at the moment the invoice actually goes out.
  // A scheduled invoice's issue_date is provisional — set to the
  // authoring day at creation — but the legal issue date is when it
  // ships. Anchoring it here keeps the printed invoice date, the Skonto
  // window (a relative "pay within N working days" counted from that
  // date) and the net-days due date all consistent with the send date.
  // Only on the first send (status 'scheduled'); 'sent' / 'overdue'
  // rows are immutable legal records and keep their stamped date.
  if (invoice.status === 'scheduled') {
    const sendDateIso = new Date().toISOString().slice(0, 10);
    const netDays = await resolveNetDaysForRow(invoice);
    // Re-anchor the due date too, but only when it was machine-set: if
    // the stored due_date still equals the auto formula off the OLD
    // base (scheduled_send_at, else the old issue_date), the admin never
    // hand-edited it and we slide it to the new issue date. A divergent
    // value means a manual override (the editor's "Override due date"
    // toggle) — leave it untouched.
    const oldBase = invoice.scheduled_send_at
      ? new Date(invoice.scheduled_send_at)
      : new Date(invoice.issue_date);
    const oldAutoDue = computeDueDate(oldBase, netDays).toISOString().slice(0, 10);
    const storedDue = invoice.due_date
      ? new Date(invoice.due_date).toISOString().slice(0, 10)
      : null;
    const updates = { issue_date: sendDateIso, updated_at: new Date() };
    if (storedDue && storedDue === oldAutoDue) {
      updates.due_date = computeDueDate(new Date(sendDateIso), netDays).toISOString().slice(0, 10);
    }
    await db('invoices').where({ id }).update(updates);
    invoice.issue_date = updates.issue_date;
    if (updates.due_date) invoice.due_date = updates.due_date;
  }

  const ctx = await buildInvoiceRenderContext(invoice, lineItems);
  const buffer = await pdfService.renderInvoiceToBuffer(ctx);

  // Persist PDF snapshot.
  const fs = require('fs');
  const path = require('path');
  const year = new Date(invoice.issue_date).getFullYear();
  const root = path.join(process.cwd(), 'storage', 'business-docs', 'invoice', String(year));
  fs.mkdirSync(root, { recursive: true });
  const pdfPath = path.join(root, `${invoice.invoice_number}.pdf`);
  fs.writeFileSync(pdfPath, buffer);

  const newStatus = invoice.status === 'overdue' ? 'overdue' : 'sent';
  await db('invoices').where({ id }).update({
    status: newStatus, sent_at: new Date(), pdf_path: pdfPath, updated_at: new Date(),
  });

  const { to: invoiceTo, cc: invoiceCc } = resolveBillingRecipients(customer, invoice.cc_pdf_email);
  await emailProcessor.queueEmail(invoice.event_id || null, invoiceTo, 'invoice_sent', {
    invoice_number: invoice.invoice_number,
    customer_name: customer.display_name || customer.first_name || customer.email.split('@')[0],
    event_name: invoice.event_name || '',
    total_amount: formatMajor(invoice.total_amount_minor, invoice.currency, ctx.locale),
    due_date: formatShortDate(invoice.due_date),
    installment_label: invoice.installment_label || '',
    installment_index: invoice.installment_index + 1,
    installment_total: invoice.installment_total,
    // Send in the customer's language (matches the ctx.locale-formatted amounts
    // above) rather than the event-first default resolution.
    __language: ctx.locale,
    cc: invoiceCc,
    attachments: [{
      filename: `${invoice.invoice_number}.pdf`,
      contentPath: pdfPath,
      contentType: 'application/pdf',
    }],
  });

  try { await logActivity('invoice_sent', { invoiceId: id }, invoice.event_id || null, `admin:${adminId}`); } catch (_) {}

  // Fire the workflow engine's invoice.sent trigger (after the row is updated +
  // the email queued). Idempotent per invoice id; no-op when the workflows flag
  // is off. Never throws into the send path.
  try {
    await require('../workflows').emitWorkflowEvent('invoice.sent', {
      entityType: 'invoice',
      entityId: id,
      payload: {
        invoiceId: id,
        invoiceNumber: invoice.invoice_number,
        eventId: invoice.event_id || null,
        customerAccountId: invoice.customer_account_id,
        customerEmail: invoiceTo,
        dueDate: invoice.due_date,
        issueDate: invoice.issue_date,
        totalMinor: invoice.total_amount_minor,
        currency: invoice.currency,
      },
    });
  } catch (_) {}

  return { sent: true, pdfPath };
}

/**
 * Materialise a Stornorechnung (cancellation invoice) for an already-
 * issued original. Atomic:
 *   1. Insert a new `invoices` row with `kind='storno'`, totals
 *      negated, no due_date / payment terms / bank account / QR,
 *      and `cancels_invoice_id` pointing at the original.
 *   2. Snapshot the original's line items at full positive amounts
 *      (the sign is carried by the row-level totals; the renderer
 *      flips line totals visually for `kind='storno'`). Preserves
 *      the migration-119 sub-item hierarchy via parent_position →
 *      parent_line_item_id resolution in `insertLineItemsHierarchical`.
 *   3. Flip the original to `status='cancelled'` and pin its
 *      `cancellation_storno_id` so the admin detail view can render
 *      a "Cancelled by Storno S-XXXX" banner.
 *
 * Returns the Storno's id. The caller is responsible for actually
 * sending it (sendStorno) — splitting the create/send seam means
 * a failed PDF render or email queue doesn't roll back the
 * cancellation itself; the storno sits in `status='scheduled'`
 * and the cron picks it up.
 */
async function createStorno(originalId, adminId, trx = db) {
  const original = await trx('invoices').where({ id: originalId }).first();
  if (!original) throw new AppError('Invoice not found', 404);
  if (original.kind === 'storno') {
    throw new AppError('Cannot Storno a Storno', 409, 'IS_STORNO');
  }
  if (original.status === 'scheduled') {
    throw new AppError(
      'This invoice has not been sent yet — Storno only applies to issued documents.',
      409,
      'USE_EDIT_INSTEAD',
    );
  }
  if (original.status === 'cancelled') {
    throw new AppError('Invoice already cancelled', 409, 'ALREADY_CANCELLED');
  }

  // Generate the Storno's sequence number from the same gap-free
  // series as regular invoices (single sequence — decision locked
  // with the maintainer; satisfies §14 (4) Nr. 4 UStG).
  // Pass trx so the sequence claim joins the caller's transaction —
  // SQLite deadlocks otherwise (1-connection default).
  const stornoNumber = await nextInvoiceNumber(trx);
  const now = new Date();
  const issueDate = now.toISOString().slice(0, 10);

  // Insert the Storno row. Totals negated for accounting integrity
  // (tax report aggregates by row-level totals, so a Storno
  // contributes correctly without the renderer needing to flip
  // signs at report time). Line items below stay positive — the
  // renderer applies the sign at presentation time.
  const insertedRow = await trx('invoices').insert({
    kind: 'storno',
    invoice_number: stornoNumber,
    customer_account_id: original.customer_account_id,
    event_id: original.event_id,
    // Inline event snapshot — copy so the Storno carries the same
    // event label as the invoice it reverses (migration 123). The
    // bookkeeper expects to see both documents under the same event.
    event_name: original.event_name || null,
    event_date: original.event_date || null,
    event_time_start: original.event_time_start || null,
    event_time_end: original.event_time_end || null,
    source_quote_id: null,
    // Migration 124 — carry the split FKs through onto the Storno row
    // so the lineage stays consistent if anyone audits the
    // cancellation document and checks the picker state.
    payment_net_days_template_id: original.payment_net_days_template_id || null,
    payment_timing_template_id: original.payment_timing_template_id || null,
    currency: original.currency,
    language: original.language,
    vat_rate: original.vat_rate,
    // Migration 130 — carry the original's VAT-code snapshot onto the Storno so
    // both documents export the same code. Conditional spread = safe on pre-130
    // DBs (undefined → omitted).
    ...(original.vat_code ? { vat_code: original.vat_code } : {}),
    shipping_amount_minor: -ensureInt(original.shipping_amount_minor || 0),
    net_amount_minor: -ensureInt(original.net_amount_minor),
    vat_amount_minor: -ensureInt(original.vat_amount_minor),
    total_amount_minor: -ensureInt(original.total_amount_minor),
    late_fee_amount_minor: 0,
    paid_amount_minor: 0,
    status: 'scheduled',
    scheduled_send_at: now,
    issue_date: issueDate,
    // Storni have no payment due — mirror issue_date to satisfy the
    // schema's NOT NULL constraint on due_date. The field is dead data
    // for kind='storno' rows: the PDF renderer suppresses the due-date
    // line, and the dunning scheduler filters kind='invoice'.
    due_date: issueDate,
    reminder_level: 0,
    cc_pdf_email: original.cc_pdf_email,
    // No payment block on a Storno — it's not a payment instrument.
    business_bank_account_id: null,
    qr_format: null,
    payment_term_template_id: null,
    // Lineage.
    cancels_invoice_id: original.id,
    replaces_invoice_id: null,
    cancellation_storno_id: null,
    // Migration 140 — Storno belongs to the same deal as the invoice
    // it cancels; both render together in the lineage view.
    deal_uuid: original.deal_uuid || crypto.randomUUID(),
    created_at: now,
    updated_at: now,
  }).returning('id');
  const stornoId = Array.isArray(insertedRow)
    ? (insertedRow[0]?.id ?? insertedRow[0])
    : insertedRow;

  // Snapshot the original's line items (positive amounts — the
  // Storno's sign convention lives on the row-level totals + the
  // renderer flip).
  const lineItems = await trx('invoice_line_items as li')
    .leftJoin('invoice_line_items as parent', 'parent.id', 'li.parent_line_item_id')
    .where('li.invoice_id', originalId)
    .orderBy('li.position', 'asc')
    .select('li.*', 'parent.position as parent_position');
  if (lineItems.length > 0) {
    const cloned = lineItems.map((li) => ({
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
    await insertLineItemsHierarchical(trx, 'invoice_line_items', 'invoice_id', stornoId, cloned);
  }

  // Flip the original to cancelled + link the Storno.
  await trx('invoices').where({ id: originalId }).update({
    status: 'cancelled',
    cancellation_storno_id: stornoId,
    updated_at: now,
  });

  try {
    await logActivity('invoice_cancelled_via_storno',
      { invoiceId: originalId, stornoId, stornoNumber },
      original.event_id || null, `admin:${adminId}`);
  } catch (_) {}

  return stornoId;
}

/**
 * Send a Stornorechnung — renders the PDF, persists it on disk,
 * flips the row to `status='sent'`, and queues the `storno_issued`
 * email to the customer with the PDF attached.
 *
 * Mirrors sendInvoice's shape so the scheduler's flush loop can
 * delegate uniformly. The email template ships in Phase 3
 * (renames the dormant `invoice_cancelled` seed); if the worker
 * picks up the job before the template lands it logs the missing
 * template — the row stays in `sent` either way.
 */
async function sendStorno(stornoId, adminId) {
  const data = await getInvoiceById(stornoId);
  if (!data) throw new AppError('Storno not found', 404);
  const { invoice: storno, lineItems } = data;
  if (storno.kind !== 'storno') {
    throw new AppError(`Expected kind='storno', got '${storno.kind}'`, 409);
  }
  if (storno.status === 'sent') return { status: 'sent' };

  const customer = await db('customer_accounts').where({ id: storno.customer_account_id }).first();
  ensureCustomerCanBill(customer);

  const ctx = await buildInvoiceRenderContext(storno, lineItems);
  const buffer = await pdfService.renderInvoiceToBuffer(ctx);

  // Persist PDF snapshot alongside regular invoices.
  const fs = require('fs');
  const path = require('path');
  const year = new Date(storno.issue_date).getFullYear();
  const root = path.join(process.cwd(), 'storage', 'business-docs', 'invoice', String(year));
  fs.mkdirSync(root, { recursive: true });
  const pdfPath = path.join(root, `${storno.invoice_number}.pdf`);
  fs.writeFileSync(pdfPath, buffer);

  await db('invoices').where({ id: stornoId }).update({
    status: 'sent',
    sent_at: new Date(),
    pdf_path: pdfPath,
    updated_at: new Date(),
  });

  // Look up the original so we can include both numbers in the
  // email body — customers' bookkeepers expect to see the pair.
  const originalRow = storno.cancels_invoice_id
    ? await db('invoices').where({ id: storno.cancels_invoice_id })
      .select('invoice_number', 'issue_date').first()
    : null;

  const { to: stornoTo, cc: stornoCc } = resolveBillingRecipients(customer, storno.cc_pdf_email);
  await emailProcessor.queueEmail(storno.event_id || null, stornoTo, 'storno_issued', {
    storno_number: storno.invoice_number,
    original_invoice_number: originalRow?.invoice_number || '',
    original_issue_date: originalRow?.issue_date ? formatShortDate(originalRow.issue_date) : '',
    customer_name: customer.display_name || customer.first_name || customer.email.split('@')[0],
    total_amount: formatMajor(Math.abs(storno.total_amount_minor), storno.currency, ctx.locale),
    // Match the customer's language (as with the ctx.locale-formatted amount).
    __language: ctx.locale,
    cc: stornoCc,
    attachments: [{
      filename: `${storno.invoice_number}.pdf`,
      contentPath: pdfPath,
      contentType: 'application/pdf',
    }],
  });

  try {
    await logActivity('storno_sent',
      { stornoId, stornoNumber: storno.invoice_number, originalInvoiceId: storno.cancels_invoice_id || null },
      storno.event_id || null, `admin:${adminId || 'system'}`);
  } catch (_) {}

  return { status: 'sent', stornoId };
}

/**
 * Reissue an invoice — the legally-correct alternative to post-send
 * editing.
 *   1. If the original is still live (sent / overdue / paid),
 *      generate a Stornorechnung for it via `createStorno` and
 *      immediately send it to the customer (sendStorno). The
 *      original flips to `status='cancelled'` and its
 *      `cancellation_storno_id` is pinned.
 *   2. Create a fresh `scheduled` invoice with a new sequence
 *      number, line items snapshotted from the original, and
 *      `replaces_invoice_id` pointing at the original so the
 *      renderer can stamp "Bezug: Ersetzt Rechnung R-XXXX".
 *
 * If the original is ALREADY cancelled (admin previously cancelled
 * it via Storno on its own), the cancel step is skipped — only the
 * replacement is created. `scheduled` originals are rejected
 * (USE_EDIT_INSTEAD) since drafts don't need legal cancellation.
 */
async function reissueInvoice(id, adminId) {
  const original = await db('invoices').where({ id }).first();
  if (!original) throw new AppError('Invoice not found', 404);
  if (original.kind === 'storno') {
    throw new AppError('Cannot reissue a Storno document', 409, 'IS_STORNO');
  }
  if (original.status === 'scheduled') {
    throw new AppError(
      'This invoice has not been sent yet — use Edit instead of Cancel & reissue.',
      409,
      'USE_EDIT_INSTEAD',
    );
  }

  // Cancel via Storno first if still live. We deliberately commit
  // the Storno BEFORE creating the replacement so a failed sendStorno
  // doesn't roll back the cancellation; the storno sits in
  // status='scheduled' and the cron picks it up. Same resiliency
  // contract as cancelInvoice.
  let stornoId = null;
  if (original.status !== 'cancelled') {
    stornoId = await db.transaction(async (trx) => createStorno(id, adminId, trx));
    try { await sendStorno(stornoId, adminId); } catch (err) {
      logger.warn('sendStorno during reissue failed — scheduler will retry', { stornoId, err: err.message });
    }
  }

  // Build the replacement. Same shape as the original — re-uses
  // createInvoice so totals are recomputed authoritatively from
  // line items (any rounding drift gets normalised). Self-join
  // carries parent_position so migration-119 sub-items survive.
  return await db.transaction(async (trx) => {
    const lineItems = await trx('invoice_line_items as li')
      .leftJoin('invoice_line_items as parent', 'parent.id', 'li.parent_line_item_id')
      .where('li.invoice_id', id)
      .orderBy('li.position', 'asc')
      .select('li.*', 'parent.position as parent_position');
    const liPayload = lineItems.map((li) => ({
      position: li.position,
      quantity: Number(li.quantity),
      description: li.description,
      unit_price_minor: Number(li.unit_price_minor),
      discount_percent: Number(li.discount_percent || 0),
      parent_position: li.parent_position == null ? null : Number(li.parent_position),
      details_text: li.details_text || null,
    }));

    const { invoiceIds: reissuedIds } = await createInvoice({
      customerAccountId: original.customer_account_id,
      sourceQuoteId: original.source_quote_id || null,
      eventId: original.event_id || null,
      language: original.language,
      currency: original.currency,
      vatRate: original.vat_rate,
      shippingAmountMinor: original.shipping_amount_minor,
      ccPdfEmail: original.cc_pdf_email,
      businessBankAccountId: original.business_bank_account_id,
      qrFormat: original.qr_format,
      paymentTermTemplateId: original.payment_term_template_id,
      // Reissue always produces a standalone invoice even when the
      // customer is on monthly billing — folding the reissued items
      // into the current period's running draft would conflate two
      // unrelated billing periods. The escape hatch keeps the
      // standard createInvoice flow.
      _skipMonthlyRouting: true,
      // Carry the split picker (migration 124) + event snapshot
      // (migration 123) onto the reissued draft so the admin doesn't
      // have to re-set them after a Cancel & reissue. createInvoice
      // already accepts these on both code paths.
      paymentNetDaysTemplateId: original.payment_net_days_template_id || null,
      paymentTimingTemplateId: original.payment_timing_template_id || null,
      eventName: original.event_name || null,
      eventDate: original.event_date || null,
      eventTimeStart: original.event_time_start || null,
      eventTimeEnd: original.event_time_end || null,
      // No installment metadata — reissue defaults to a single
      // standalone invoice. If the admin needs the same split they
      // can run the original conversion again from the quote.
      lineItems: liPayload,
      // Migration 140 — reissue inherits the cancelled original's
      // deal_uuid so Storno + replacement + cancelled all group
      // under one deal lineage view.
      dealUuid: original.deal_uuid || null,
    }, adminId, trx);
    // Reissue always produces a single invoice (no installments
    // forced), so the array length is 1.
    const newId = reissuedIds[0];

    await trx('invoices').where({ id: newId }).update({
      replaces_invoice_id: id,
      updated_at: new Date(),
    });

    try {
      await logActivity('invoice_reissued',
        { originalInvoiceId: id, newInvoiceId: newId, stornoId },
        original.event_id || null, `admin:${adminId}`);
    } catch (_) {}

    return { id: newId, replaces: id, stornoId };
  });
}

/**
 * Release a `pending_delivery` invoice for sending. Used when the
 * photographer has actually delivered the photos and is ready to
 * collect the final installment — flips the status to `scheduled`
 * with `scheduled_send_at = now`, then immediately calls sendInvoice
 * so the email goes out without waiting for the next scheduler tick.
 *
 * Refuses to act on rows that aren't pending — admins should use
 * sendInvoice / sendReminder for the normal `scheduled`/`sent` flow.
 */
async function releaseForDelivery(id, adminId) {
  const invoice = await db('invoices').where({ id }).first();
  if (!invoice) throw new AppError('Invoice not found', 404);
  if (invoice.status !== 'pending_delivery') {
    throw new AppError(
      `Invoice is not awaiting delivery (status: '${invoice.status}')`,
      409,
      'NOT_PENDING_DELIVERY',
    );
  }
  const now = new Date();
  await db('invoices').where({ id }).update({
    status: 'scheduled',
    scheduled_send_at: now,
    updated_at: now,
  });
  try {
    await logActivity('invoice_released_for_delivery', { invoiceId: id }, invoice.event_id || null, `admin:${adminId}`);
  } catch (_) {}
  // Fire immediately rather than waiting for the next scheduler
  // tick — admin clicked the button because they want it out now.
  return await sendInvoice(id, adminId);
}

/**
 * Cancel an invoice. The behaviour depends on whether the document
 * was ever issued:
 *
 *   - `scheduled` (draft, no PDF emitted): soft cancel — status
 *     flips to 'cancelled', nothing leaves the system. No Storno is
 *     generated because no document exists for the customer to
 *     reverse.
 *
 *   - `sent` / `overdue` / `paid` (issued): generate a
 *     Stornorechnung (cancellation invoice) with its own sequence
 *     number, attach a signed PDF, and email it to the customer.
 *     Original flips to 'cancelled' and pins its
 *     `cancellation_storno_id` for the admin lineage view. This is
 *     the only §14c-defensible cancellation path under DACH tax law
 *     once an invoice has been delivered to the recipient.
 *
 *     Note we allow `paid` here on purpose — bookkeepers cancel
 *     paid invoices when issuing refunds. The actual money
 *     movement (refund, carry-forward as Anzahlung) is handled
 *     separately; the Storno is the document leg.
 *
 *   - `cancelled` (already): 409, `ALREADY_CANCELLED`.
 *
 * Returns `{ cancelled: true, stornoId? }` so the caller can
 * surface "Storno S-XXXX wurde erzeugt" feedback when applicable.
 */
async function cancelInvoice(id, adminId) {
  const invoice = await db('invoices').where({ id }).first();
  if (!invoice) throw new AppError('Invoice not found', 404);
  if (invoice.kind === 'storno') {
    throw new AppError('Cannot cancel a Storno document', 409, 'IS_STORNO');
  }
  if (invoice.status === 'cancelled') {
    throw new AppError('Invoice already cancelled', 409, 'ALREADY_CANCELLED');
  }

  // Draft path: nothing was issued, soft cancel and we're done.
  if (invoice.status === 'scheduled') {
    await db('invoices').where({ id }).update({
      status: 'cancelled', updated_at: new Date(),
    });
    try {
      await logActivity('invoice_cancelled',
        { invoiceId: id, viaStorno: false },
        invoice.event_id || null, `admin:${adminId}`);
    } catch (_) {}
    return { cancelled: true, stornoId: null };
  }

  // Issued path: Storno required. Commit createStorno in its own
  // transaction so a failed sendStorno doesn't roll back the
  // cancellation; the scheduler picks up an unsent Storno on the
  // next tick.
  const stornoId = await db.transaction(async (trx) => createStorno(id, adminId, trx));
  try { await sendStorno(stornoId, adminId); } catch (err) {
    logger.warn('sendStorno after cancelInvoice failed — scheduler will retry', { stornoId, err: err.message });
  }
  return { cancelled: true, stornoId };
}

async function triggerMonthlyBillNow(customerId, adminId) {
  const draft = await db('invoices')
    .where({ customer_account_id: customerId, is_monthly_draft: true })
    .orderBy('id', 'desc')
    .first();
  if (!draft) {
    throw new AppError('No pending monthly bill for this customer', 409, 'NO_MONTHLY_DRAFT');
  }
  const items = await db('invoice_line_items').where({ invoice_id: draft.id }).limit(1);
  if (items.length === 0) {
    throw new AppError('Monthly draft is empty — nothing to bill', 409, 'EMPTY_DRAFT');
  }

  // Arm the draft: clear the discriminator, pin issue_date to today,
  // and set scheduled_send_at to now so the flush pass + sendInvoice
  // path treats it like any other ready-to-send invoice. Logged as a
  // distinct activity so the audit trail shows admin override vs the
  // scheduler's automatic fire.
  const issueDate = new Date().toISOString().slice(0, 10);
  await db('invoices').where({ id: draft.id }).update({
    is_monthly_draft: false,
    issue_date: issueDate,
    scheduled_send_at: new Date(),
    updated_at: new Date(),
  });
  try {
    await logActivity('monthly_bill_triggered_manually',
      { invoiceId: draft.id, customerId, periodEnd: draft.monthly_period_end },
      null, `admin:${adminId}`);
  } catch (_) {}

  // Inline send so admin gets immediate feedback (PDF stored, status
  // flipped to 'sent', email queued). A failure here doesn't roll
  // back the arming — the scheduler will pick it up on the next tick.
  try {
    await sendInvoice(draft.id, adminId);
  } catch (err) {
    logger.warn('triggerMonthlyBillNow: inline send failed — scheduler will retry',
      { invoiceId: draft.id, err: err.message });
  }
  return { invoiceId: draft.id, invoiceNumber: draft.invoice_number };
}
module.exports = {
  sendInvoice,
  createStorno,
  sendStorno,
  reissueInvoice,
  releaseForDelivery,
  cancelInvoice,
  triggerMonthlyBillNow,
};
