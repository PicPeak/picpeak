// Extracted verbatim from invoiceService.js — see ../invoiceService.js for the
// module-level overview. Do not add behavior here without updating the entry re-exports.

const { db, logActivity } = require('../../database/db');
const { getAppSetting } = require('../../utils/appSettings');
const { AppError } = require('../../utils/errors');
const { formatShortDate } = require('../../utils/dateFormatter');
const { resolveBillingRecipients } = require('../_billingRecipients');
const pdfService = require('../pdfService');
const emailProcessor = require('../emailProcessor');
const { ensureInt } = require('../../utils/numericHelpers');
const { hasColumnCached } = require('../../utils/schemaCache');
const { formatMajor } = require('./helpers');
const { getInvoiceById } = require('./queries');
const { buildInvoiceRenderContext } = require('./render');


/**
 * Manually trigger a reminder email. The scheduler does this
 * automatically; this is the "Send reminder now" button on the
 * invoice detail page.
 */
async function sendReminder(id, levelOverride, adminId) {
  const data = await getInvoiceById(id);
  if (!data) throw new AppError('Invoice not found', 404);
  const { invoice, lineItems } = data;
  if (invoice.status !== 'sent' && invoice.status !== 'overdue') {
    throw new AppError(`Cannot remind on status '${invoice.status}'`, 409);
  }
  const newLevel = levelOverride || (invoice.reminder_level + 1);
  if (newLevel > 3) {
    throw new AppError('Reminder level exhausted', 409);
  }
  return await applyReminder(invoice, lineItems, newLevel, adminId);
}

// Per-reminder Mahngebühr in minor units (0 when disabled). Flat amount OR a
// percentage of the invoice gross, per crm_invoices_late_fee_type. Charged from
// the 2nd reminder onwards. ⚠️ A late fee is only enforceable if the concrete
// amount is stated in the AGB — verify with a Treuhänder (the admin UI says so).
// Net per-reminder Mahngebühr (flat amount or % of invoice gross), 0 disabled.
async function resolveLateFeeNetMinor(invoice) {
  if ((await getAppSetting('crm_invoices_late_fee_enabled')) === false) return 0;
  const type = (await getAppSetting('crm_invoices_late_fee_type')) || 'flat';
  let fee;
  if (type === 'percent') {
    const pct = Number(await getAppSetting('crm_invoices_late_fee_percent')) || 0;
    fee = Math.round(Number(invoice.total_amount_minor || 0) * pct / 100);
  } else {
    fee = ensureInt(await getAppSetting('crm_invoices_late_fee_minor')) || 2500;
  }
  return Math.max(0, fee);
}

// VAT rate on the fee — jurisdiction-dependent (CH: yes; DE/AT: no), so
// toggle-gated AND org-VAT-gated: 0 when the org has no default VAT rate, so
// enabling the toggle on a non-VAT org adds nothing.
async function resolveLateFeeVatRate() {
  if ((await getAppSetting('crm_invoices_late_fee_vat_enabled')) !== true) return 0;
  const profile = await db('business_profile').where({ id: 1 }).first('vat_rate_default');
  return Number(profile?.vat_rate_default) || 0;
}

// Gross per-reminder fee (net + VAT) — for the admin payment-check preview.
async function resolvePerReminderFeeMinor(invoice) {
  const net = await resolveLateFeeNetMinor(invoice);
  if (net <= 0) return 0;
  const rate = await resolveLateFeeVatRate();
  return rate > 0 ? net + Math.round(net * rate / 100) : net;
}

async function applyReminder(invoice, lineItems, level, adminId) {
  const customer = await db('customer_accounts').where({ id: invoice.customer_account_id }).first();

  // Per fee-bearing reminder (levels 2..level): 2nd = 1×, 3rd = 2×, computed
  // from `level` so re-applying the same level never stacks. The fee is dunning
  // STATE on the row (gross + the VAT portion) — it is NOT shown on the
  // immutable invoice; it appears on the separate Mahnung document below.
  let lateFeeGross = invoice.late_fee_amount_minor || 0;
  let lateFeeVat = invoice.late_fee_vat_minor || 0;
  if (level >= 2) {
    const net = await resolveLateFeeNetMinor(invoice);
    const rate = await resolveLateFeeVatRate();
    const vatPer = rate > 0 ? Math.round(net * rate / 100) : 0;
    lateFeeGross = (level - 1) * (net + vatPer);
    lateFeeVat = (level - 1) * vatPer;
  }
  const newTotal = Number(invoice.total_amount_minor || 0) + lateFeeGross;

  const update = {
    status: 'overdue',
    reminder_level: level,
    last_reminder_sent_at: new Date(),
    late_fee_amount_minor: lateFeeGross,
    updated_at: new Date(),
  };
  if (await hasColumnCached('invoices', 'late_fee_vat_minor')) update.late_fee_vat_minor = lateFeeVat;
  await db('invoices').where({ id: invoice.id }).update(update);

  // Fire invoice.overdue at the status→overdue flip. Deduped per (workflow,
  // invoice), so across the reminder ladder it triggers a flow at most once.
  // Best-effort / fail-closed.
  try {
    await require('../workflows').emitWorkflowEvent('invoice.overdue', {
      entityType: 'invoice',
      entityId: invoice.id,
      payload: {
        invoiceId: invoice.id,
        invoiceNumber: invoice.invoice_number,
        eventId: invoice.event_id || null,
        customerAccountId: invoice.customer_account_id,
        customerEmail: customer?.email || null,
        dueDate: invoice.due_date,
        reminderLevel: level,
        totalMinor: invoice.total_amount_minor,
        currency: invoice.currency,
      },
    });
  } catch (_) {}

  // Render the MAHNUNG (reminder letter). The original invoice PDF is left
  // UNTOUCHED (immutable). The Mahnung reuses the invoice layout via a
  // 'mahnung' kind: same line items + the Mahngebühr row + the new total, with
  // a "Mahnung" title and no QR (it would encode the old amount).
  const fresh = await db('invoices').where({ id: invoice.id }).first();
  const ctx = await buildInvoiceRenderContext(fresh, lineItems);
  ctx.doc.kind = 'mahnung';
  ctx.doc.reminderLevel = level;
  ctx.doc.lateFeeMinor = lateFeeGross;
  ctx.totals.lateFeeAmountMinor = lateFeeGross;
  const buffer = await pdfService.renderInvoiceToBuffer(ctx);
  const fs = require('fs');
  const path = require('path');
  const year = new Date(fresh.issue_date).getFullYear();
  const root = path.join(process.cwd(), 'storage', 'business-docs', 'mahnung', String(year));
  fs.mkdirSync(root, { recursive: true });
  const mahnungPath = path.join(root, `${fresh.invoice_number}_mahnung_L${level}.pdf`);
  fs.writeFileSync(mahnungPath, buffer);

  // days_overdue floors at 1 (a "0 days overdue" reminder reads as broken).
  const rawDaysOverdue = Math.floor((Date.now() - new Date(invoice.due_date).getTime()) / 86400000);
  const daysOverdue = Math.max(1, rawDaysOverdue);
  const templateKey = level === 1 ? 'invoice_reminder_first' : 'invoice_reminder_second';
  const locale = ctx.locale || invoice.language || 'de';
  const outstandingMinor = Math.max(0, newTotal - Number(invoice.paid_amount_minor || 0));

  // Attach the (unchanged) original invoice PDF + the new Mahnung.
  const attachments = [];
  if (invoice.pdf_path && fs.existsSync(invoice.pdf_path)) {
    attachments.push({ filename: `${invoice.invoice_number}.pdf`, contentPath: invoice.pdf_path, contentType: 'application/pdf' });
  }
  attachments.push({ filename: `${fresh.invoice_number}_Mahnung.pdf`, contentPath: mahnungPath, contentType: 'application/pdf' });

  const { to: reminderTo, cc: reminderCc } = resolveBillingRecipients(customer, invoice.cc_pdf_email);
  try {
    await emailProcessor.queueEmail(invoice.event_id || null, reminderTo, templateKey, {
      invoice_number: invoice.invoice_number,
      customer_name: customer.display_name || customer.first_name || customer.email.split('@')[0],
      total_amount: formatMajor(invoice.total_amount_minor, invoice.currency, locale),
      new_total_amount: formatMajor(newTotal, invoice.currency, locale),
      outstanding_amount: formatMajor(outstandingMinor, invoice.currency, locale),
      paid_amount: formatMajor(invoice.paid_amount_minor, invoice.currency, locale),
      late_fee_amount: formatMajor(lateFeeGross, invoice.currency, locale),
      due_date: formatShortDate(invoice.due_date),
      days_overdue: daysOverdue,
      cc: reminderCc,
      attachments,
    // Dunning reminders are relationship mail — hold to business hours.
    }, { respectBusinessHours: true });
  } catch (err) {
    // Don't leave the just-rendered Mahnung PDF orphaned on disk if queueing the
    // email failed — it would only be reachable via the next reminder anyway.
    try { fs.unlinkSync(mahnungPath); } catch (_) { /* best-effort cleanup */ }
    throw err;
  }

  try {
    await logActivity('invoice_reminder_sent', { invoiceId: invoice.id, level, lateFeeMinor: lateFeeGross },
      invoice.event_id || null, `admin:${adminId || 'system'}`);
  } catch (_) {}

  return { level, lateFeeMinor: lateFeeGross };
}

// ---------------------------------------------------------------------
// Payment-check workflow (admin-confirmed reminders)
// ---------------------------------------------------------------------

/**
 * Resolve the admin email address that should receive the payment-
 * check prompt. Priority:
 *   1. created_by_admin_id's email (the admin who issued the invoice)
 *   2. First admin user with bills.manage permission
 *   3. business_profile.email as a last resort
 * Returns null when nothing usable is found — caller logs + skips.
 */
/**
 * Resolve the effective Skonto percentage for an invoice at the
 * current moment. Resolution chain (matches pdfService rendering):
 *   1. invoice.payment_term_snapshot.skonto_percent
 *   2. source quote's payment_term_snapshot.skonto_percent
 *   3. global crm_invoices_skonto_percent_default
 * Returns null when nothing is configured.
 *
 * Lifted into a helper so the payment-check action and the email
 * template (which both need to know "does this invoice qualify for a
 * Paid-with-Skonto button?") share one source of truth.
 */
async function resolveSkontoPercentForInvoice(invoice) {
  // Per-invoice opt-out (migration 126) wins over every other source.
  // Admin sets this on Storni / replacement invoices / payment-plan
  // installments that shouldn't qualify for the discount even when
  // the global default offers it.
  if (invoice.skonto_disabled) return null;
  // Per-customer opt-out (migration 112) — a customer that negotiated
  // "no Skonto" as a contract term never qualifies, so the admin
  // doesn't have to tick the per-invoice toggle on every invoice.
  // Falls through customer → invoice → snapshot → quote → global.
  if (invoice.customer_account_id) {
    const cust = await db('customer_accounts')
      .where({ id: invoice.customer_account_id })
      .select('skonto_disabled')
      .first();
    if (cust && cust.skonto_disabled) return null;
  }
  const parseSnap = (raw) => {
    if (!raw) return null;
    if (typeof raw === 'object') return raw;
    try { return JSON.parse(raw); } catch { return null; }
  };
  const invSnap = parseSnap(invoice.payment_term_snapshot);
  if (invSnap?.skonto_percent != null && Number(invSnap.skonto_percent) > 0) {
    return Number(invSnap.skonto_percent);
  }
  if (invoice.source_quote_id) {
    const q = await db('quotes').where({ id: invoice.source_quote_id }).select('payment_term_snapshot').first();
    const qSnap = parseSnap(q?.payment_term_snapshot);
    if (qSnap?.skonto_percent != null && Number(qSnap.skonto_percent) > 0) {
      return Number(qSnap.skonto_percent);
    }
  }
  const defaultPct = Number(await getAppSetting('crm_invoices_skonto_percent_default'));
  return Number.isFinite(defaultPct) && defaultPct > 0 ? defaultPct : null;
}

async function resolveAdminEmailForInvoice(invoice) {
  if (invoice.created_by_admin_id) {
    const admin = await db('admin_users').where({ id: invoice.created_by_admin_id }).first();
    if (admin?.email) return { email: admin.email, name: admin.username || admin.email };
  }
  // Fallback: business_profile.email.
  const profile = await db('business_profile').where({ id: 1 }).first();
  if (profile?.email) return { email: profile.email, name: profile.company_name || profile.email };
  return null;
}
module.exports = {
  sendReminder,
  resolveLateFeeNetMinor,
  resolveLateFeeVatRate,
  resolvePerReminderFeeMinor,
  applyReminder,
  resolveSkontoPercentForInvoice,
  resolveAdminEmailForInvoice,
};
