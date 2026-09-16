// Extracted verbatim from invoiceService.js — see ../invoiceService.js for the
// module-level overview. Do not add behavior here without updating the entry re-exports.

const crypto = require('crypto');
const { db, logActivity } = require('../../database/db');
const logger = require('../../utils/logger');
const { getAppSetting } = require('../../utils/appSettings');
const { AppError } = require('../../utils/errors');
const { formatShortDate } = require('../../utils/dateFormatter');
const { getFrontendBaseUrl, DEFAULT_ABSOLUTE_BASE } = require('../../utils/frontendUrl');
const emailProcessor = require('../emailProcessor');
const { ensureInt } = require('../../utils/numericHelpers');
const { formatMajor } = require('./helpers');
const { auditedInsert, auditedUpdate } = require('../accountingHistory');
const { applyReminder, resolveAdminEmailForInvoice, resolvePerReminderFeeMinor, resolveSkontoPercentForInvoice } = require('./reminders');

// Payment-check token lifetime (GHSA-wg94-f86h-vq68 hardening). This
// unauthenticated magic link is the only gate on a write to the
// invoice ledger, so it's kept short rather than the prior 30 days.
// The scheduler re-queues a fresh token daily (throttled by
// last_payment_check_at, see queuePaymentCheckEmail below) for as
// long as the invoice stays past its reminder cutoff, so a short TTL
// doesn't strand an admin who hasn't acted yet — they just get a new
// link on the next tick.
const PAYMENT_CHECK_TOKEN_TTL_MS = 72 * 60 * 60 * 1000; // 72h

/**
 * Record a payment against an invoice. Supports partial payments
 * (multiple rows accumulate into `paid_amount_minor`). Status flips
 * to `paid` once the running total meets or exceeds total_amount_minor.
 */
async function markPaid(id, payment, adminId) {
  return recordPayment(id, payment, adminId, adminId);
}

// markPaid with the change-history actor kept apart from
// recorded_by_admin_id: the payment-check link records the payment on
// behalf of the invoice's admin, but the history names the link.
async function recordPayment(id, { amountMinor, paidAt, paymentMethod, reference, notes, skontoApplied }, adminId, actor) {
  const amount = ensureInt(amountMinor);
  if (amount <= 0) {
    throw new AppError('amount must be > 0', 400);
  }
  // Skonto bookkeeping (migration 126). When the admin ticks "Paid
  // with Skonto" we store both the flag AND the absolute discount
  // in minor units. Computing the discount here (instead of in the
  // renderer at report time) means the value is frozen against
  // later template/percentage edits — the tax-report row stays
  // accurate for years.
  const skontoFlag = Boolean(skontoApplied);
  let invoice;
  let skontoAmountMinor;

  const markResult = await db.transaction(async (trx) => {
    // Serialize payments before inserting their FK children or reading the
    // running sum. Otherwise two successful inserts can overwrite the total
    // with different partial sums, even with a compatible recorder lock.
    const invoiceQuery = trx('invoices').where({ id });
    if (trx.client.config.client === 'pg') invoiceQuery.forNoKeyUpdate();
    invoice = await invoiceQuery.first();
    if (!invoice) throw new AppError('Invoice not found', 404);
    if (invoice.status === 'cancelled') {
      throw new AppError('Cannot mark a cancelled invoice as paid', 409);
    }
    skontoAmountMinor = skontoFlag
      ? Math.max(0, ensureInt(invoice.total_amount_minor) - amount)
      : null;
    await auditedInsert(trx, 'invoice_payment_log', {
      invoice_id: id,
      amount_minor: amount,
      paid_at: paidAt ? new Date(paidAt) : new Date(),
      payment_method: paymentMethod || null,
      reference: reference || null,
      notes: notes || null,
      recorded_by_admin_id: adminId,
      skonto_applied: skontoFlag,
      skonto_amount_minor: skontoAmountMinor,
      created_at: new Date(),
    }, { actor, source: 'invoice.markPaid' });
    const sumRow = await trx('invoice_payment_log').where({ invoice_id: id }).sum('amount_minor as total').first();
    const total = ensureInt(sumRow?.total || 0);
    // Consider the invoice paid when the recorded payments cover the
    // invoice total. The late fee is NOT added to the threshold here
    // — admins frequently waive it once the customer actually pays
    // (and chasing the extra 25 CHF after a 1500 CHF invoice clears
    // makes nobody happy). Admin can record a separate payment_log
    // row if they did collect the fee; status flips to paid the
    // moment the principal is covered.
    //
    // Skonto path (migration 126): when the admin flagged this
    // payment as Skonto-applied, the discounted amount equals the
    // expected payment — flip to 'paid' even though paid_amount_minor
    // is strictly less than total_amount_minor. Without this branch
    // the invoice would sit in 'sent' or 'overdue' forever despite
    // being legitimately settled.
    const skontoEffectiveTotal = skontoFlag
      ? ensureInt(invoice.total_amount_minor) - (skontoAmountMinor || 0)
      : ensureInt(invoice.total_amount_minor);
    const isFull = total >= skontoEffectiveTotal;

    const update = {
      paid_amount_minor: total,
      payment_method: paymentMethod || invoice.payment_method,
      payment_reference: reference || invoice.payment_reference,
      updated_at: new Date(),
    };
    if (isFull) {
      update.status = 'paid';
      update.paid_at = paidAt ? new Date(paidAt) : new Date();
    }
    await auditedUpdate(trx, 'invoices', { id }, update, { actor, source: 'invoice.markPaid' });

    // Pass trx: through the global db this insert waits on the single-
    // connection SQLite pool for the connection this transaction holds.
    try { await logActivity(isFull ? 'invoice_paid' : 'invoice_partial_payment',
      { invoiceId: id, amountMinor: amount, totalPaidMinor: total },
      invoice.event_id || null, `admin:${adminId}`, trx); } catch (_) { /* non-fatal */ }

    return { paidTotalMinor: total, status: isFull ? 'paid' : invoice.status };
  });

  // Migration 127 — admin payment-received notification. Fires only
  // on the transition into 'paid' so admins don't get duplicate
  // emails when additional payment-log rows are recorded after the
  // invoice already cleared (rare but possible — e.g. late-fee
  // top-up). Queued after the transaction so a failed email never
  // rolls back a recorded payment. It used to run inside it despite
  // this comment, and its global-db reads and email_queue insert then
  // stalled on SQLite's single connection until the notification was
  // dropped. Carried Skonto context lets the template show the
  // discount line conditionally.
  if (markResult.status === 'paid' && invoice.status !== 'paid') {
    try {
      await queueInvoicePaidAdminNotification({
        invoice,
        paidTotalMinor: markResult.paidTotalMinor,
        paymentMethod: paymentMethod || invoice.payment_method || null,
        paymentReference: reference || invoice.payment_reference || null,
        paidAt: paidAt ? new Date(paidAt) : new Date(),
        skontoApplied: skontoFlag,
        skontoAmountMinor: skontoAmountMinor || 0,
      });
    } catch (err) {
      // Notification is best-effort — don't surface a 500 to the
      // admin when the recorded payment itself succeeded.
      logger.warn('invoice_paid admin notification failed to queue', { invoiceId: id, err: err.message });
    }
  }

  // Fire invoice.paid for the workflow engine ONLY on the transition into
  // 'paid' (mirrors the admin-notification guard above). After the commit so a
  // workflow side effect can never roll back the recorded payment.
  if (markResult.status === 'paid' && invoice.status !== 'paid') {
    try {
      await require('../workflows').emitWorkflowEvent('invoice.paid', {
        entityType: 'invoice',
        entityId: id,
        payload: {
          invoiceId: id,
          invoiceNumber: invoice.invoice_number,
          eventId: invoice.event_id || null,
          customerAccountId: invoice.customer_account_id,
          paidTotalMinor: markResult.paidTotalMinor,
        },
      });
    } catch (_) { /* non-fatal */ }
  }
  return markResult;
}

/**
 * Generate a fresh payment-check token for an invoice and queue the
 * admin email with three signed action buttons. Throttled to once
 * per 24h per invoice via invoices.last_payment_check_at.
 *
 * Returns { token, sent: bool, reason? } so callers can log /
 * surface the outcome.
 */
/**
 * Queue the admin "payment received" notification (migration 127).
 * Called from markPaid the first time an invoice transitions into
 * `status='paid'`. Resolves the admin's address via the same chain
 * the payment-check email uses (created_by_admin_id → business
 * profile fallback). Silently no-ops when no admin email can be
 * resolved — caller logs the warn line.
 */
async function queueInvoicePaidAdminNotification({
  invoice, paidTotalMinor, paymentMethod, paymentReference,
  paidAt, skontoApplied, skontoAmountMinor,
}) {
  const adminContact = await resolveAdminEmailForInvoice(invoice);
  if (!adminContact?.email) {
    logger.warn('invoice_paid notification skipped — no admin email resolved',
      { invoiceId: invoice.id });
    return;
  }

  const profile = await db('business_profile').where({ id: 1 }).first();
  const locale = invoice.language || profile?.default_locale || 'de';

  const customer = await db('customer_accounts').where({ id: invoice.customer_account_id }).first();
  // Resolve the Skonto percentage at notification time so the
  // template can render "Paid with Skonto X%" without a second query.
  // Same resolver the rest of the Skonto surfaces use — null when
  // skonto_disabled is true or no Skonto is configured.
  const skontoPercent = skontoApplied
    ? await resolveSkontoPercentForInvoice(invoice)
    : null;

  await emailProcessor.queueEmail(invoice.event_id || null, adminContact.email,
    'invoice_paid_admin_notification', {
      invoice_number: invoice.invoice_number,
      customer_name: customer?.company_name
        || customer?.display_name
        || [customer?.first_name, customer?.last_name].filter(Boolean).join(' ')
        || customer?.email || '',
      event_name: invoice.event_name || '',
      // Keep the body language consistent with the locale-formatted amounts.
      __language: locale,
      total_amount: formatMajor(invoice.total_amount_minor, invoice.currency, locale),
      paid_amount: formatMajor(paidTotalMinor, invoice.currency, locale),
      payment_method: paymentMethod || '',
      payment_reference: paymentReference || '',
      paid_at: formatShortDate(paidAt),
      skonto_applied: !!skontoApplied,
      skonto_percent: skontoApplied && skontoPercent ? skontoPercent : '',
      skonto_discount_amount: skontoApplied
        ? formatMajor(skontoAmountMinor, invoice.currency, locale)
        : '',
    });

  try {
    await logActivity('invoice_paid_admin_notified', { invoiceId: invoice.id },
      invoice.event_id || null, 'system');
  } catch (_) { /* non-fatal */ }
}

async function queuePaymentCheckEmail(invoiceId, { skipThrottle = false, actor = null } = {}) {
  const invoice = await db('invoices').where({ id: invoiceId }).first();
  if (!invoice) return { sent: false, reason: 'not_found' };
  if (!['sent', 'overdue'].includes(invoice.status)) {
    return { sent: false, reason: `wrong_status_${invoice.status}` };
  }
  const now = new Date();
  if (!skipThrottle && invoice.last_payment_check_at) {
    const last = new Date(invoice.last_payment_check_at).getTime();
    if (now.getTime() - last < 24 * 60 * 60 * 1000) {
      return { sent: false, reason: 'throttled_24h' };
    }
  }

  const adminContact = await resolveAdminEmailForInvoice(invoice);
  if (!adminContact?.email) {
    logger.warn('Payment-check email skipped — no admin email resolved', { invoiceId });
    return { sent: false, reason: 'no_admin_email' };
  }

  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(now.getTime() + PAYMENT_CHECK_TOKEN_TTL_MS);
  await db('invoice_payment_check_tokens').insert({
    invoice_id: invoiceId,
    token,
    expires_at: expiresAt,
    created_at: now,
  });
  await auditedUpdate(db, 'invoices', { id: invoiceId }, {
    last_payment_check_at: now,
    updated_at: now,
  }, { actor, source: 'invoice.paymentCheck.queue' });

  const customer = await db('customer_accounts').where({ id: invoice.customer_account_id }).first();
  const profile = await db('business_profile').where({ id: 1 }).first();
  const locale = invoice.language || profile?.default_locale || 'de';

  // Determine whether the customer reminder will include a Mahngebühr
  // if the admin selects "Not paid" / "Partial" — surfaced to the
  // email so the admin sees the consequence before clicking.
  const reminderFeeMinor = await resolvePerReminderFeeMinor(invoice);
  const nextLevel = (invoice.reminder_level || 0) + 1;
  const willChargeFee = reminderFeeMinor > 0 && nextLevel >= 2;

  // FRONTEND_URL -> general_site_url (the setup wizard's answer) -> the
  // legacy app_frontend_url key -> localhost. Was defaulting to
  // https://app.example.com, which shipped a dead placeholder domain into
  // customer-facing payment-reminder emails (#705).
  const baseUrl = (await getFrontendBaseUrl())
    || (await getAppSetting('app_frontend_url'))
    || DEFAULT_ABSOLUTE_BASE;
  const buildUrl = (action) =>
    `${baseUrl.replace(/\/$/, '')}/payment-check/${token}?action=${action}`;

  // Outstanding = gross total + late fee − already paid. The admin
  // is being asked about what's STILL OWED, not the original gross
  // figure — so surface outstanding + paid in the email context.
  // Partial payments logged earlier (e.g. via a previous admin
  // payment-check click) are reflected, so the admin doesn't get
  // asked "did the customer pay CHF 234?" when they already paid
  // CHF 134 of it.
  const paidMinor = Number(invoice.paid_amount_minor || 0);
  const lateFeeAlreadyMinor = Number(invoice.late_fee_amount_minor || 0);
  const outstandingMinor = Math.max(0,
    Number(invoice.total_amount_minor || 0) + lateFeeAlreadyMinor - paidMinor);
  const hasPartial = paidMinor > 0;

  // Resolve Skonto for the optional 4th button (migration 126). Only
  // surface the button when (a) Skonto is configured for this invoice
  // AND (b) the customer paid within the Skonto window — past the
  // window the discount is moot. Both checks are visible to the
  // template so the email can hide the button conditionally.
  const skontoPercent = await resolveSkontoPercentForInvoice(invoice);
  const hasSkonto = !!skontoPercent && skontoPercent > 0;
  const skontoDiscountedTotalMinor = hasSkonto
    ? Math.round(Number(invoice.total_amount_minor) * (1 - Number(skontoPercent) / 100))
    : null;

  await emailProcessor.queueEmail(invoice.event_id || null, adminContact.email,
    'invoice_payment_check', {
      invoice_number: invoice.invoice_number,
      customer_name: customer?.company_name
        || customer?.display_name
        || [customer?.first_name, customer?.last_name].filter(Boolean).join(' ')
        || customer?.email || '',
      event_name: invoice.event_name || '',
      // Keep the body language consistent with the locale the amounts are
      // formatted in, instead of event-first resolution (admin-facing gate).
      __language: locale,
      due_date: formatShortDate(invoice.due_date),
      total_amount: formatMajor(invoice.total_amount_minor, invoice.currency, locale),
      paid_amount: formatMajor(paidMinor, invoice.currency, locale),
      outstanding_amount: formatMajor(outstandingMinor, invoice.currency, locale),
      has_partial_payment: hasPartial,
      paid_url:    buildUrl('paid_full'),
      partial_url: buildUrl('partial'),
      unpaid_url:  buildUrl('unpaid'),
      // Skonto button — template uses {{#if has_skonto}} to render the
      // fourth button only when the invoice qualifies.
      has_skonto: hasSkonto,
      skonto_percent: hasSkonto ? skontoPercent : '',
      skonto_amount: hasSkonto
        ? formatMajor(skontoDiscountedTotalMinor, invoice.currency, locale)
        : '',
      skonto_url: hasSkonto ? buildUrl('paid_with_skonto') : '',
      late_fee_due: willChargeFee,
      late_fee_amount: formatMajor(reminderFeeMinor, invoice.currency, locale),
    });

  try {
    await logActivity('invoice_payment_check_sent', { invoiceId, token: token.slice(0, 8) },
      invoice.event_id || null, 'scheduler');
  } catch (_) { /* non-fatal */ }

  return { token, sent: true };
}

/**
 * Validate a payment-check token and return the invoice context
 * the public page needs. Token must exist, not be expired, not
 * already used.
 */
async function getPaymentCheckByToken(token) {
  const row = await db('invoice_payment_check_tokens').where({ token }).first();
  if (!row) throw new AppError('Token not found', 404);
  if (row.used_at) {
    const err = new AppError('This link has already been used', 410, 'TOKEN_ALREADY_USED');
    err.usedAt = row.used_at;
    err.usedAction = row.used_action;
    throw err;
  }
  if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) {
    throw new AppError('This link has expired', 410, 'TOKEN_EXPIRED');
  }
  const invoice = await db('invoices').where({ id: row.invoice_id }).first();
  if (!invoice) throw new AppError('Invoice not found', 404);
  const customer = await db('customer_accounts').where({ id: invoice.customer_account_id }).first();

  const outstandingMinor = Math.max(0,
    Number(invoice.total_amount_minor || 0) + Number(invoice.late_fee_amount_minor || 0)
    - Number(invoice.paid_amount_minor || 0));

  // Surface the Skonto state so the public page can decide whether to
  // render the "Paid with Skonto" action card (migration 126). Only
  // applies when the invoice's payment terms actually carry a Skonto
  // percentage — admin shouldn't see the option on an invoice that
  // never offered the discount.
  const skontoPercent = await resolveSkontoPercentForInvoice(invoice);
  const hasSkonto = !!skontoPercent && skontoPercent > 0;
  const skontoDiscountedTotalMinor = hasSkonto
    ? Math.round(Number(invoice.total_amount_minor) * (1 - Number(skontoPercent) / 100))
    : null;

  return {
    invoiceNumber: invoice.invoice_number,
    customer: {
      label: customer?.company_name
        || [customer?.first_name, customer?.last_name].filter(Boolean).join(' ')
        || customer?.display_name || customer?.email || '',
      email: customer?.email,
    },
    issueDate: invoice.issue_date,
    dueDate: invoice.due_date,
    totalMinor: invoice.total_amount_minor,
    paidMinor: invoice.paid_amount_minor,
    lateFeeMinor: invoice.late_fee_amount_minor,
    outstandingMinor,
    currency: invoice.currency,
    status: invoice.status,
    reminderLevel: invoice.reminder_level,
    expiresAt: row.expires_at,
    hasSkonto,
    skontoPercent: hasSkonto ? skontoPercent : null,
    skontoDiscountedTotalMinor,
  };
}

/**
 * Best-effort admin notification for every write via the public,
 * unauthenticated payment-check route (GHSA-wg94-f86h-vq68
 * hardening). Token possession is the only gate on that route, so
 * this fires on every successful action — 'paid_full', 'partial',
 * 'unpaid', 'paid_with_skonto' — regardless of what the ledger
 * effect ends up being, so an admin always sees the action happen.
 * Callers MUST wrap this in try/catch: a failed send must never
 * fail (or roll back) the ledger write it's reporting on.
 */
async function notifyAdminOfPaymentCheckAction({ invoice, action, amountMinor, ip }) {
  const adminContact = await resolveAdminEmailForInvoice(invoice);
  if (!adminContact?.email) {
    logger.warn('Payment-check action notification skipped — no admin email resolved',
      { invoiceId: invoice.id, action });
    return;
  }

  const profile = await db('business_profile').where({ id: 1 }).first();
  const locale = invoice.language || profile?.default_locale || 'de';
  const customer = await db('customer_accounts').where({ id: invoice.customer_account_id }).first();

  await emailProcessor.queueEmail(invoice.event_id || null, adminContact.email,
    'invoice_payment_check_action_recorded', {
      invoice_number: invoice.invoice_number,
      customer_name: customer?.company_name
        || customer?.display_name
        || [customer?.first_name, customer?.last_name].filter(Boolean).join(' ')
        || customer?.email || '',
      event_name: invoice.event_name || '',
      __language: locale,
      action,
      amount: amountMinor ? formatMajor(ensureInt(amountMinor), invoice.currency, locale) : '',
      has_amount: !!amountMinor,
      ip: ip || 'unknown',
      recorded_at: formatShortDate(new Date()),
    });
}

/**
 * Record the admin's payment-check action and fire the downstream
 * consequences:
 *   - 'paid_full' → markPaid for the outstanding amount, no reminder.
 *   - 'partial'   → markPaid for the amount supplied, then fire the
 *                   next reminder for the remainder.
 *   - 'unpaid'    → fire the next reminder (level 1 or 2) with the
 *                   existing Mahngebühr logic in applyReminder.
 *
 * Atomic: token consumption + invoice status update happen in one
 * transaction. The reminder email is queued AFTER the txn commits
 * to avoid emailing a customer about a payment that never
 * actually committed.
 */
async function recordPaymentCheckAction({ token, action, amountMinor, ip, adminId }) {
  // 'paid_with_skonto' (migration 126) is a fourth admin action — the
  // customer settled the bill within the early-payment-discount window,
  // so the recorded payment equals total minus the configured Skonto %.
  // Same token-consumption semantics as 'paid_full'.
  if (!['paid_full', 'paid_with_skonto', 'partial', 'unpaid'].includes(action)) {
    throw new AppError('Invalid action', 400);
  }

  const row = await db('invoice_payment_check_tokens').where({ token }).first();
  if (!row) throw new AppError('Token not found', 404);
  if (row.used_at) {
    throw new AppError('This link has already been used', 410, 'TOKEN_ALREADY_USED');
  }
  if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) {
    throw new AppError('This link has expired', 410, 'TOKEN_EXPIRED');
  }
  const invoice = await db('invoices').where({ id: row.invoice_id }).first();
  if (!invoice) throw new AppError('Invoice not found', 404);

  const outstandingMinor = Math.max(0,
    Number(invoice.total_amount_minor || 0) + Number(invoice.late_fee_amount_minor || 0)
    - Number(invoice.paid_amount_minor || 0));

  if (action === 'partial') {
    const amt = ensureInt(amountMinor);
    if (amt <= 0) throw new AppError('partial amount must be > 0', 400);
    if (amt > outstandingMinor) throw new AppError('partial amount exceeds outstanding', 400);
  }

  // Consume the token first — atomic with status update so a
  // double-click can't fire the action twice.
  const now = new Date();
  const updated = await db('invoice_payment_check_tokens')
    .where({ id: row.id })
    .whereNull('used_at')
    .update({
      used_at: now,
      used_action: action,
      used_amount_minor: action === 'partial' ? ensureInt(amountMinor) : null,
      used_ip: ip || null,
    });
  if (updated === 0) {
    // Lost a race with another consumer.
    throw new AppError('This link has already been used', 410, 'TOKEN_ALREADY_USED');
  }

  try {
    await logActivity('invoice_payment_check_recorded',
      { invoiceId: invoice.id, action, amountMinor: amountMinor || null },
      invoice.event_id || null,
      adminId ? `admin:${adminId}` : 'public:payment-check');
  } catch (_) { /* non-fatal */ }

  // Notify the admin this write happened. Best-effort / non-blocking
  // — the ledger write above already committed, and a failed
  // notification send must not undo or fail it.
  if (!adminId) {
    try {
      await notifyAdminOfPaymentCheckAction({ invoice, action, amountMinor, ip });
    } catch (err) {
      logger.warn('Payment-check action admin notification failed', {
        invoiceId: invoice.id, action, err: err.message,
      });
    }
  }

  // --- Apply the action -----------------------------------------
  const actor = adminId || 'public:payment-check';
  if (action === 'paid_full') {
    await recordPayment(invoice.id, {
      amountMinor: outstandingMinor,
      paymentMethod: invoice.payment_method || 'bank_transfer',
      reference: invoice.payment_reference || null,
      notes: 'Confirmed via admin payment-check link',
    }, adminId || invoice.created_by_admin_id, actor);
    return { applied: 'paid_full' };
  }

  if (action === 'paid_with_skonto') {
    // Resolve the Skonto percentage at click time so admins can't
    // accidentally double-discount after the template changed. Same
    // resolution chain pdfService uses: invoice snapshot → source
    // quote snapshot → global crm_invoices_skonto_percent_default.
    const skontoPercent = await resolveSkontoPercentForInvoice(invoice);
    if (!skontoPercent || skontoPercent <= 0) {
      throw new AppError('No Skonto configured on this invoice', 409, 'SKONTO_NOT_CONFIGURED');
    }
    const discountedTotalMinor = Math.round(
      Number(invoice.total_amount_minor) * (1 - Number(skontoPercent) / 100),
    );
    // Outstanding-aware: if the customer already paid part of the
    // bill (rare on the Skonto path, but possible after a partial),
    // record only the remaining slice up to the discounted total.
    const paidMinor = Number(invoice.paid_amount_minor || 0);
    const remainingMinor = Math.max(0, discountedTotalMinor - paidMinor);
    if (remainingMinor <= 0) {
      throw new AppError('Invoice already paid past the Skonto threshold', 409);
    }
    await recordPayment(invoice.id, {
      amountMinor: remainingMinor,
      paymentMethod: invoice.payment_method || 'bank_transfer',
      reference: invoice.payment_reference || null,
      notes: `Confirmed via admin payment-check link (Skonto ${skontoPercent}% applied)`,
      skontoApplied: true,
    }, adminId || invoice.created_by_admin_id, actor);
    return { applied: 'paid_with_skonto', skontoPercent };
  }

  if (action === 'partial') {
    const amt = ensureInt(amountMinor);
    await recordPayment(invoice.id, {
      amountMinor: amt,
      paymentMethod: invoice.payment_method || 'bank_transfer',
      reference: invoice.payment_reference || null,
      notes: 'Partial payment confirmed via admin payment-check link',
    }, adminId || invoice.created_by_admin_id, actor);
    // Then fire the customer reminder for the remainder, unless
    // markPaid flipped the invoice to paid (i.e. the partial
    // amount equalled the outstanding).
    const refreshed = await db('invoices').where({ id: invoice.id }).first();
    if (refreshed.status !== 'paid') {
      const nextLevel = (refreshed.reminder_level || 0) + 1;
      if (nextLevel <= 3) {
        const lineItems = await db('invoice_line_items')
          .where({ invoice_id: invoice.id }).orderBy('position', 'asc');
        await applyReminder(refreshed, lineItems, nextLevel, adminId, actor);
      }
    }
    return { applied: 'partial' };
  }

  // 'unpaid'
  const nextLevel = (invoice.reminder_level || 0) + 1;
  if (nextLevel > 3) {
    // Already at max reminder — admin has to take this offline.
    return { applied: 'unpaid', reminderSkipped: 'max_level_reached' };
  }
  const lineItems = await db('invoice_line_items')
    .where({ invoice_id: invoice.id }).orderBy('position', 'asc');
  await applyReminder(invoice, lineItems, nextLevel, adminId, actor);
  return { applied: 'unpaid', reminderLevel: nextLevel };
}
module.exports = {
  markPaid,
  queueInvoicePaidAdminNotification,
  queuePaymentCheckEmail,
  getPaymentCheckByToken,
  recordPaymentCheckAction,
};
