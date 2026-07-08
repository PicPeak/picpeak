// Extracted verbatim from invoiceService.js — see ../invoiceService.js for the
// module-level overview. Do not add behavior here without updating the entry re-exports.

const { db, logActivity } = require('../../database/db');
const logger = require('../../utils/logger');
const { getAppSetting } = require('../../utils/appSettings');
const { ensureInt } = require('../../utils/numericHelpers');
const { queuePaymentCheckEmail } = require('./payments');
const { sendInvoice } = require('./sending');


/**
 * Cron tick — find scheduled invoices ready to send + invoices past
 * due date that need a reminder. Called by invoiceSchedulerService.
 */
async function runScheduledTasks() {
  const now = new Date();

  // 1. Flush scheduled invoices.
  const ready = await db('invoices')
    .where({ status: 'scheduled' })
    .andWhere(function() {
      this.whereNotNull('scheduled_send_at').andWhere('scheduled_send_at', '<=', now);
    })
    .limit(20);
  for (const inv of ready) {
    try {
      await sendInvoice(inv.id, null);
    } catch (err) {
      logger.error('Scheduled invoice send failed', { invoiceId: inv.id, err: err.message });
    }
  }

  // 2. Monthly-bill issuance (migration 128).
  //
  // Walk every monthly draft whose period_end is today-or-earlier.
  // - If the draft has zero line items, skip silently (empty month
  //   per user spec — no invoice issued, no email, just a log).
  // - Otherwise flip is_monthly_draft=false and arm scheduled_send_at
  //   to `now` so the next flush-pass picks it up and runs the
  //   standard sendInvoice path. Keeping the issuance one tick away
  //   from this pass means email queueing + activity log + dunning
  //   schedule all stay on the existing well-trodden code paths
  //   instead of duplicating logic here.
  const monthlyToday = new Date(now);
  monthlyToday.setHours(0, 0, 0, 0);
  const dueDrafts = await db('invoices')
    .where({ is_monthly_draft: true })
    .andWhere('monthly_period_end', '<=', monthlyToday.toISOString().slice(0, 10))
    .limit(50);
  for (const draft of dueDrafts) {
    try {
      const items = await db('invoice_line_items').where({ invoice_id: draft.id }).limit(1);
      if (items.length === 0) {
        // Empty month — leave the draft alone (admin may still add
        // items between now and end-of-day) OR mark it consumed so
        // the next save creates a fresh period draft. We pick the
        // latter: clear is_monthly_draft so the next createInvoice
        // for this customer mints a new period.
        //
        // Status is 'skipped', not 'cancelled': the latter implies
        // an admin (or Storno) deliberately voided a real invoice;
        // an empty monthly period is a "nothing happened" non-event
        // that we still record for audit-trail continuity. Listing
        // queries that aggregate cancelled rows (e.g. the Bills list
        // cancellation footnote) should not pull skipped rows in.
        await db('invoices').where({ id: draft.id }).update({
          is_monthly_draft: false,
          status: 'skipped',
          updated_at: new Date(),
        });
        logger.info('Monthly bill skipped — no items queued', {
          invoiceId: draft.id, customerId: draft.customer_account_id,
        });
        try {
          await logActivity('monthly_bill_skipped_empty',
            { invoiceId: draft.id, customerId: draft.customer_account_id },
            null, 'scheduler');
        } catch (_) {}
        continue;
      }
      // Arm for the flush pass: clear the draft flag, set the send
      // time to now, recompute due_date from issue_date + the global
      // crm_invoices_net_days_default (best-effort; admin can override
      // by editing the draft before the cadence day).
      const issueDate = monthlyToday.toISOString().slice(0, 10);
      await db('invoices').where({ id: draft.id }).update({
        is_monthly_draft: false,
        issue_date: issueDate,
        scheduled_send_at: new Date(),
        updated_at: new Date(),
      });
      try {
        await logActivity('monthly_bill_issued',
          { invoiceId: draft.id, customerId: draft.customer_account_id,
            periodEnd: draft.monthly_period_end },
          null, 'scheduler');
      } catch (_) {}
    } catch (err) {
      logger.error('Monthly bill issuance failed', { invoiceId: draft.id, err: err.message });
    }
  }

  // 3. Overdue payment-check prompts (if reminders enabled).
  //
  // NEW behavior (migration 115/116): instead of auto-firing the
  // customer reminder when an invoice goes overdue, we email the
  // ADMIN with three signed-token action buttons:
  //   - Paid in full  → markPaid for the outstanding amount
  //   - Partial       → admin enters amount; partial + reminder
  //   - Not paid yet  → reminder fires (with Mahngebühr at level 2)
  //
  // The reminder thresholds still gate when the prompt fires:
  //   - level 0 invoice past firstCutoff  → prompt for level-1 path
  //   - level 1 invoice past secondCutoff → prompt for level-2 path
  // Throttled to one email per 24h per invoice via
  // invoices.last_payment_check_at.
  const remindersEnabled = await getAppSetting('crm_invoices_reminders_enabled');
  // Mutual exclusion with the workflow engine: the hardcoded ladder stands down
  // only when the invoice_dunning built-in is ENABLED (then the engine fires the
  // payment-check emails). A disabled built-in leaves this ladder running — so
  // the flow can ship disabled without dunning going dark, and disabling the
  // flow reverts to the ladder. Fails closed → ladder stays on if the subsystem
  // is down.
  let engineDrivesDunning = false;
  try {
    engineDrivesDunning = await require('../workflows').isBuiltinFlowActive('invoice_dunning');
  } catch (_) { /* workflows tables absent / flag system down → ladder stays on */ }
  if (remindersEnabled !== false && !engineDrivesDunning) {
    const firstDays  = ensureInt(await getAppSetting('crm_invoices_reminder_first_days')) || 14;
    const secondDays = ensureInt(await getAppSetting('crm_invoices_reminder_second_days')) || 30;

    const firstCutoff  = new Date(now.getTime() - firstDays  * 86400000);
    const secondCutoff = new Date(now.getTime() - secondDays * 86400000);

    // Pre-reminder check (would-be-level-1).
    // `kind='invoice'` filter keeps Stornorechnungen out of the
    // dunning ladder — they have no due_date and no payment
    // expectation; reminding on them would be a customer-facing
    // bug.
    const firstBatch = await db('invoices')
      .where('kind', 'invoice')
      .whereIn('status', ['sent', 'overdue'])
      .where('reminder_level', 0)
      .where('due_date', '<=', firstCutoff)
      .limit(20);
    for (const inv of firstBatch) {
      try {
        await queuePaymentCheckEmail(inv.id);
      } catch (err) {
        logger.error('Payment-check email failed', { invoiceId: inv.id, err: err.message });
      }
    }

    // Pre-reminder check (would-be-level-2, including Mahngebühr).
    const secondBatch = await db('invoices')
      .where('kind', 'invoice')
      .whereIn('status', ['sent', 'overdue'])
      .where('reminder_level', 1)
      .where('due_date', '<=', secondCutoff)
      .limit(20);
    for (const inv of secondBatch) {
      try {
        await queuePaymentCheckEmail(inv.id);
      } catch (err) {
        logger.error('Payment-check email (level 2) failed', { invoiceId: inv.id, err: err.message });
      }
    }
  }
}
module.exports = {
  runScheduledTasks,
};
