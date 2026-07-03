/**
 * Workflow action + condition handlers that touch real picpeak data.
 *
 * Registered at load time (index.js requires this module). Kept separate from
 * registry.js (which holds only primitives) so the I/O-coupled handlers don't
 * bloat the pure core.
 *
 * Email routing rule (locked requirement): INTERNAL/admin mail sends
 * immediately; EXTERNAL/customer mail respects the business-hours floor. The
 * action sets queueEmail's `respectBusinessHours` from the recipient class.
 *
 * The create/prepare-document actions (quote/contract/event/gallery/invoice)
 * are registered so flows validate, but are intentionally NOT wired to the
 * services yet — they record a `skipped` step with a clear reason so the gap
 * is observable rather than silent. Wiring is a follow-up commit.
 */
const registry = require('./registry');

// --- Conditions ---

// True once the run's invoice entity is settled (paid_at set, status paid, or
// the cumulative paid amount covers the total).
registry.registerCondition('invoice_paid', async (ctx) => {
  const id = ctx.run.entity_id;
  if (!id) return false;
  const inv = await ctx.db('invoices').where({ id }).first();
  if (!inv) return false;
  if (inv.paid_at) return true;
  if (inv.status === 'paid') return true;
  const paid = Number(inv.paid_amount_minor) || 0;
  const total = Number(inv.total_amount_minor);
  return Number.isFinite(total) && total > 0 && paid >= total;
});

// --- Actions ---

// Queue an email. recipientClass 'admin' (internal) sends immediately;
// anything else (customer/external) respects the business-hours floor.
registry.registerAction('send_email', async (ctx) => {
  const cfg = ctx.node.config || {};
  if (ctx.vars?.__dryRun) return { dryRun: true, would: 'send_email', recipientClass: cfg.recipientClass || cfg.recipient || 'customer', emailType: cfg.emailType || cfg.template };
  const recipientClass = cfg.recipientClass || cfg.recipient || 'customer';
  const isInternal = recipientClass === 'admin' || recipientClass === 'internal';
  const to = cfg.to
    || ctx.vars[isInternal ? 'adminEmail' : 'customerEmail']
    || ctx.vars.recipientEmail;
  if (!to) return { skipped: true, reason: 'no recipient resolved' };

  const emailProcessor = require('../emailProcessor');
  const eventId = ctx.vars.eventId || null;
  const emailType = cfg.emailType || cfg.template || 'workflow_notification';
  const emailData = { ...(cfg.emailData || {}), ...(ctx.vars.emailData || {}) };

  // INTERNAL/admin = immediate; EXTERNAL/customer = business-hours floor.
  const respectBusinessHours = !isInternal;
  await emailProcessor.queueEmail(eventId, to, emailType, emailData, { respectBusinessHours });
  return { sent_to: to, recipientClass, respectBusinessHours };
});

// Fire the existing admin payment-check email (the dunning gate). Delegates to
// invoiceService.queuePaymentCheckEmail so the proven escalation +
// Mahngebühr / reminder_level state machine (recordPaymentCheckAction) stays
// the single source of truth — the workflow only decides WHEN it fires. This
// is what makes the built-in dunning flow a faithful replacement for the
// hardcoded ladder (paired with the mutual-exclusion guard in runScheduledTasks).
registry.registerAction('queue_payment_check', async (ctx) => {
  const id = ctx.run.entity_id;
  if (!id) return { skipped: true, reason: 'no invoice entity' };
  if (ctx.vars?.__dryRun) return { dryRun: true, would: 'queue_payment_check', invoiceId: id };
  await require('../invoiceService').queuePaymentCheckEmail(id);
  return { payment_check_queued: id };
});

// After the dunning loop exhausts (e.g. 3 unpaid reminders), consolidate
// everything collections needs into ONE email to the admin: customer data, the
// outstanding total (invoice + late fees − paid) and the invoice PDF attached —
// ready to forward to an Inkasso agency / for Betreibung. Internal mail → sent
// immediately. Does NOT touch the invoice.
registry.registerAction('escalate_to_collections', async (ctx) => {
  const id = ctx.run.entity_id;
  if (!id) return { skipped: true, reason: 'no invoice entity' };
  if (ctx.vars?.__dryRun) return { dryRun: true, would: 'escalate_to_collections', invoiceId: id };
  const { db } = ctx;
  const invoice = await db('invoices').where({ id }).first();
  if (!invoice) return { skipped: true, reason: 'invoice not found' };
  const customer = invoice.customer_account_id
    ? await db('customer_accounts').where({ id: invoice.customer_account_id }).first()
    : null;
  const profile = await db('business_profile').where({ id: 1 }).first();
  const adminEmail = ctx.vars?.adminEmail || profile?.email || null;
  if (!adminEmail) return { skipped: true, reason: 'no admin email' };

  const currency = invoice.currency || 'CHF';
  const fmt = (m) => `${currency} ${(Number(m || 0) / 100).toFixed(2)}`;
  const total = Number(invoice.total_amount_minor || 0);
  const fee = Number(invoice.late_fee_amount_minor || 0);
  const paid = Number(invoice.paid_amount_minor || 0);
  const outstanding = Math.max(0, total + fee - paid);
  const address = [customer?.address, customer?.postal_code, customer?.city, customer?.country_name]
    .filter(Boolean).join(', ');

  const attachments = [];
  try {
    const fs = require('fs');
    if (invoice.pdf_path && fs.existsSync(invoice.pdf_path)) {
      attachments.push({ filename: `${invoice.invoice_number}.pdf`, contentPath: invoice.pdf_path, contentType: 'application/pdf' });
    }
  } catch (_) { /* attachment is best-effort */ }

  await require('../emailProcessor').queueEmail(invoice.event_id || null, adminEmail, 'invoice_collections_handoff', {
    invoice_number: invoice.invoice_number,
    customer_name: customer?.display_name || customer?.email || '—',
    customer_email: customer?.email || '',
    customer_address: address,
    event_name: invoice.event_name || '',
    original_amount: fmt(total),
    late_fee_amount: fee ? fmt(fee) : '',
    paid_amount: fmt(paid),
    outstanding_amount: fmt(outstanding),
    due_date: invoice.due_date ? String(invoice.due_date).slice(0, 10) : '',
    reminder_level: invoice.reminder_level || 0,
    attachments,
  }, { respectBusinessHours: false }); // internal/admin → immediate

  return { collections_handoff_to: adminEmail, outstanding };
});

// --- Gallery / pre-event notification actions (cutover) ---
//
// These DELEGATE to the existing service send functions, so the engine path is
// byte-identical to the legacy hourly checker/pass it replaces (same templates,
// recipients, variables, dedup). The legacy path stands down when the matching
// built-in flow is enabled (isBuiltinFlowActive guard), so exactly one email
// goes out.

// Send the gallery expiration-warning email for the run's event entity.
registry.registerAction('notify_gallery_expiring', async (ctx) => {
  const id = ctx.run.entity_id;
  if (!id) return { skipped: true, reason: 'no event entity' };
  if (ctx.vars?.__dryRun) return { dryRun: true, would: 'notify_gallery_expiring', eventId: id };
  const event = await ctx.db('events').where({ id }).first();
  if (!event) return { skipped: true, reason: 'event not found' };
  await require('../expirationChecker').queueExpirationWarning(event);
  return { warning_queued: id };
});

// Send the gallery_expired email(s) for the run's event entity.
registry.registerAction('notify_gallery_expired', async (ctx) => {
  const id = ctx.run.entity_id;
  if (!id) return { skipped: true, reason: 'no event entity' };
  if (ctx.vars?.__dryRun) return { dryRun: true, would: 'notify_gallery_expired', eventId: id };
  const event = await ctx.db('events').where({ id }).first();
  if (!event) return { skipped: true, reason: 'event not found' };
  await require('../expirationChecker').sendGalleryExpiredEmails(event);
  return { expired_email_queued: id };
});

// Send the pre-event customer reminder for the run's event entity. Delegates to
// eventReminderService so per-event overrides + sent_at idempotency are honoured.
registry.registerAction('notify_pre_event', async (ctx) => {
  const id = ctx.run.entity_id;
  if (!id) return { skipped: true, reason: 'no event entity' };
  // The template GROUP is chosen on THIS block (config.templateGroup, e.g.
  // 'event_reminder'); the exact template is still auto-picked by event type
  // within that group. Blank → the default group.
  const templateGroup = ctx.node.config?.templateGroup || null;
  if (ctx.vars?.__dryRun) return { dryRun: true, would: 'notify_pre_event', eventId: id, templateGroup };
  const res = await require('../eventReminderService').sendReminderForEvent(id, { templateGroup });
  return res;
});

// Call a webhook (the `webhook` node type + the "Call a webhook" action both
// resolve here). The flow author picks a CONFIGURED webhook subscription
// (config.webhookId, managed in Settings → Webhooks); this enqueues a real
// delivery for it, so it rides the same worker pipeline as every other webhook:
// per-delivery SSRF re-validation (validateExternalUrl / GHSA-wmjx-pc37-272r),
// HMAC signing with the subscription's secret, retries/backoff, and the audit
// log — all inherited, nothing reimplemented. Best-effort: an unset / missing /
// inactive webhook records an observable skipped step.
registry.registerAction('webhook', async (ctx) => {
  const webhookId = ctx.node.config?.webhookId ? Number(ctx.node.config.webhookId) : null;
  if (!webhookId) return { skipped: true, reason: 'no webhook selected (pick one in Settings → Webhooks)' };
  if (ctx.vars?.__dryRun) return { dryRun: true, would: 'webhook', webhookId };

  const eventType = `workflow.${ctx.run.trigger_event || 'webhook'}`;
  const res = await require('../webhookService').enqueueForWebhook(webhookId, eventType, {
    workflow: { id: ctx.run.workflow_id, version: ctx.run.version },
    run: {
      id: ctx.run.id,
      trigger_event: ctx.run.trigger_event,
      entity_type: ctx.run.entity_type,
      entity_id: ctx.run.entity_id,
    },
    vars: ctx.vars || {},
  });
  return res.enqueued
    ? { webhook_enqueued: res.webhookId, deliveryId: res.deliveryId }
    : { skipped: true, reason: res.reason };
});

// --- Booking document actions (draft-seam cutover) ---
//
// The booking flows trigger on quote.accepted, so the run entity is the QUOTE.
// prepare_* create DRAFT documents (idempotent, reusing the proven converters)
// and stash the created ids in the run context; send_document then dispatches
// the matching draft. Flows run system-side, so the actor is resolved from the
// quote's creator (else the workflow's creator, else the first admin).

async function resolveActor(ctx) {
  try {
    if (ctx.run.entity_type === 'quote' && ctx.run.entity_id) {
      const q = await ctx.db('quotes').where({ id: ctx.run.entity_id }).first('created_by_admin_id');
      if (q?.created_by_admin_id) return q.created_by_admin_id;
    }
    const wf = await ctx.db('workflows').where({ id: ctx.run.workflow_id }).first('created_by');
    if (wf?.created_by) return wf.created_by;
    const admin = await ctx.db('admin_users').orderBy('id', 'asc').first('id');
    return admin?.id || null;
  } catch (_) { return null; }
}

// Prepare a DRAFT contract from the accepted quote (idempotent via the quote's
// converted_contract_id back-pointer).
registry.registerAction('prepare_contract', async (ctx) => {
  const quoteId = ctx.run.entity_id;
  if (ctx.run.entity_type !== 'quote' || !quoteId) return { skipped: true, reason: 'prepare_contract needs a quote entity' };
  if (ctx.vars?.__dryRun) return { dryRun: true, would: 'prepare_contract', quoteId };
  const adminId = await resolveActor(ctx);
  const res = await require('../contractService').createFromQuote(quoteId, adminId);
  ctx.vars.preparedContractId = res.contractId;
  return { contract_prepared: res.contractId, alreadyConverted: !!res.alreadyConverted };
});

// Create a DRAFT event/gallery from the accepted quote. convertToEvent creates
// the event as is_draft=true AND (unless skipInvoices) schedules its invoices —
// on HOLD here so they wait for the review gate + send_document. The created
// invoice ids are stashed so the flow's downstream prepare_invoice ADOPTS them
// (instead of double-creating, which would also throw ALREADY_CONVERTED_TO_EVENT).
// Shared by prepare_event, prepare_gallery (alias — a gallery IS an event in
// picpeak), and reserve_date (skipInvoices: a pure date hold, no money docs).
async function doPrepareEvent(ctx, label, { skipInvoices = false } = {}) {
  const quoteId = ctx.run.entity_id;
  if (ctx.run.entity_type !== 'quote' || !quoteId) return { skipped: true, reason: `${label} needs a quote entity` };
  if (ctx.vars?.__dryRun) return { dryRun: true, would: label, quoteId };
  if (ctx.vars.preparedEventId) {
    return { already: true, eventId: ctx.vars.preparedEventId, invoiceIds: ctx.vars.preparedInvoiceIds || [] };
  }
  const adminId = await resolveActor(ctx);
  const res = await require('../quoteService').convertToEvent(quoteId, adminId, { hold: true, skipInvoices });
  ctx.vars.preparedEventId = res.eventId;
  // The flow's prepare_invoice short-circuits on a populated preparedInvoiceIds,
  // so the event's held invoices flow straight through to send_document.
  ctx.vars.preparedInvoiceIds = res.invoiceIds || [];
  return { event_prepared: res.eventId, invoiceIds: ctx.vars.preparedInvoiceIds, alreadyConverted: !!res.alreadyConverted };
}

registry.registerAction('prepare_event', (ctx) => doPrepareEvent(ctx, 'prepare_event'));
// A gallery IS an event in picpeak — same draft-seam behaviour.
registry.registerAction('prepare_gallery', (ctx) => doPrepareEvent(ctx, 'prepare_gallery'));
// Reserve the date only: create the draft event as a pure calendar hold with NO
// invoices. A flow can invoice later (or never).
registry.registerAction('reserve_date', (ctx) => doPrepareEvent(ctx, 'reserve_date', { skipInvoices: true }));

// Create a DRAFT quote. From a quote entity (e.g. quote.declined → re-quote) it
// duplicates that quote; from a customer entity (customer.created) it opens a
// blank draft quote for them. Idempotent via ctx.vars.preparedQuoteId.
registry.registerAction('prepare_quote', async (ctx) => {
  if (ctx.vars?.__dryRun) return { dryRun: true, would: 'prepare_quote', entity: ctx.run.entity_type };
  if (ctx.vars.preparedQuoteId) return { already: true, quoteId: ctx.vars.preparedQuoteId };
  const adminId = await resolveActor(ctx);
  const quoteService = require('../quoteService');
  let quoteId;
  if (ctx.run.entity_type === 'quote' && ctx.run.entity_id) {
    quoteId = await quoteService.duplicateQuote(ctx.run.entity_id, adminId);
  } else if (ctx.run.entity_type === 'customer' && ctx.run.entity_id) {
    quoteId = await quoteService.createQuote({ customerAccountId: ctx.run.entity_id }, adminId);
  } else {
    return { skipped: true, reason: 'prepare_quote needs a quote or customer entity' };
  }
  ctx.vars.preparedQuoteId = quoteId;
  return { quote_prepared: quoteId };
});

// Prepare DRAFT invoice(s) from the accepted quote — created on HOLD (no
// scheduled_send_at) so the scheduler won't auto-send before the review gate.
// When prepare_event already ran in this flow, the event's held invoices are
// already in ctx.vars.preparedInvoiceIds and this adopts them (no double-create).
registry.registerAction('prepare_invoice', async (ctx) => {
  const quoteId = ctx.run.entity_id;
  if (ctx.run.entity_type !== 'quote' || !quoteId) return { skipped: true, reason: 'prepare_invoice needs a quote entity' };
  if (ctx.vars?.__dryRun) return { dryRun: true, would: 'prepare_invoice', quoteId };
  if (Array.isArray(ctx.vars.preparedInvoiceIds) && ctx.vars.preparedInvoiceIds.length) {
    return { already: true, invoiceIds: ctx.vars.preparedInvoiceIds };
  }
  const adminId = await resolveActor(ctx);
  let invoiceIds;
  try {
    const res = await require('../quoteService').convertToInvoiceOnly(quoteId, adminId, { draft: true });
    invoiceIds = res.invoiceIds || [];
  } catch (err) {
    // Crash-recovery re-run: the quote may already be 'converted' (convert
    // throws). Recover the drafts by the quote's deal_uuid so we don't lose them.
    const quote = await ctx.db('quotes').where({ id: quoteId }).first('deal_uuid');
    invoiceIds = quote?.deal_uuid
      ? (await ctx.db('invoices').where({ deal_uuid: quote.deal_uuid }).select('id')).map((r) => r.id)
      : [];
    if (!invoiceIds.length) throw err;
  }
  ctx.vars.preparedInvoiceIds = invoiceIds;
  return { invoice_prepared: invoiceIds };
});

// Send a prepared draft document (config.document = 'invoice' | 'contract').
registry.registerAction('send_document', async (ctx) => {
  const doc = ctx.node.config?.document || 'invoice';
  if (ctx.vars?.__dryRun) return { dryRun: true, would: 'send_document', document: doc };
  const adminId = await resolveActor(ctx);

  if (doc === 'invoice') {
    const ids = ctx.vars.preparedInvoiceIds || [];
    if (!ids.length) return { skipped: true, reason: 'no prepared invoice to send' };
    const invoiceService = require('../invoiceService');
    let sent = 0;
    for (const id of ids) { await invoiceService.sendInvoice(id, adminId); sent += 1; }
    return { invoices_sent: sent };
  }
  if (doc === 'contract') {
    const cid = ctx.vars.preparedContractId;
    if (!cid) return { skipped: true, reason: 'no prepared contract to send' };
    await require('../contractService').sendContract(cid, adminId);
    return { contract_sent: cid };
  }
  return { skipped: true, reason: `send_document for '${doc}' not implemented yet` };
});

module.exports = {};
