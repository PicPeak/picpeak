/**
 * invoiceSchedulerService — cron worker for CRM automation.
 *
 * Despite the name, this scheduler now drives THREE jobs:
 *   1. Flush invoices whose `scheduled_send_at` has passed and status
 *      is still 'scheduled' — flips them to 'sent' and queues the email.
 *   2. Run the overdue reminder ladder (first reminder at due_date +
 *      reminder_first_days, second at +second_days w/ late fee).
 *   3. Pre-event customer reminders (migration 143) — sends a nudge
 *      N days before `event_date`. Idempotent via
 *      `events.event_reminder_sent_at`.
 *
 * Jobs 1+2 delegate to `invoiceService.runScheduledTasks()`; job 3
 * to `eventReminderService.runEventReminderPass()`. The two service
 * calls run sequentially inside the same tick but in independent
 * try/catch blocks so a failure in one doesn't suppress the other.
 *
 * Wired in server.js boot path next to expirationChecker — see that
 * module for the cron pattern. Runs hourly; the per-row guards inside
 * each service prevent duplicate sends.
 *
 * The module name is kept as `invoiceSchedulerService` for backward
 * compatibility with the existing server.js import; rename to
 * `crmSchedulerService` is a future cleanup.
 */

const cron = require('node-cron');
const invoiceService = require('./invoiceService');
const eventReminderService = require('./eventReminderService');
const quoteService = require('./quoteService');
const logger = require('../utils/logger');

let task = null;

async function runTick() {
  try {
    await invoiceService.runScheduledTasks();
  } catch (err) {
    logger.error('Invoice scheduler tick failed', { err: err.message });
  }
  try {
    await eventReminderService.runEventReminderPass();
  } catch (err) {
    logger.error('Event reminder pass failed', { err: err.message });
  }
  try {
    // Fire workflow events for quote responses whose 15-min toggle window has
    // now locked (deferred at response time so accepting can't convert the quote
    // before the customer's grace period to change their mind expires).
    const finalized = await quoteService.finalizeQuoteResponses();
    if (finalized) logger.info('CRM scheduler: finalized locked quote responses', { finalized });
  } catch (err) {
    logger.error('Quote response finalize pass failed', { err: err.message });
  }
  try {
    // Resume workflow runs whose wait has elapsed. No-op (fails closed) when
    // the `workflows` feature flag is off. Independent try/catch so a workflow
    // failure never suppresses the invoice/reminder jobs above.
    const wf = require('./workflows');
    const resumed = await wf.runDueWaits();
    if (resumed) logger.info('Workflow scheduler: resumed waiting runs', { resumed });
    // Fire pre-event reminders for events entering an enabled flow's lead window.
    const preEvent = await wf.emitDueEventReminders();
    if (preEvent) logger.info('Workflow scheduler: emitted pre-event reminders', { preEvent });
    // Recover runs orphaned by a crash (stuck in running/pending). Runs on the
    // boot tick too, so a restart catches anything stranded during downtime.
    const recovered = await wf.recoverStaleRuns();
    if (recovered) logger.warn('Workflow scheduler: recovered orphaned runs', { recovered });
  } catch (err) {
    logger.error('Workflow resume pass failed', { err: err.message });
  }
}

function startInvoiceScheduler() {
  if (task) {
    logger.info('Invoice scheduler already running');
    return task;
  }
  // Hourly at minute 11 to spread load away from other hourly jobs.
  task = cron.schedule('11 * * * *', async () => {
    logger.info('Invoice scheduler: tick');
    await runTick();
  });
  logger.info('Invoice scheduler started (hourly @ :11) — invoice + event-reminder jobs');
  // Run once on boot so a missed window (server restart) gets caught
  // up immediately.
  runTick().catch((err) => {
    logger.warn('Invoice scheduler initial tick failed', { err: err.message });
  });
  return task;
}

function stopInvoiceScheduler() {
  if (task) {
    task.stop();
    task = null;
    logger.info('Invoice scheduler stopped');
  }
}

module.exports = { startInvoiceScheduler, stopInvoiceScheduler };
