/**
 * customerDocumentRequestReminderService — the reminder ladder for open
 * document requests (#1444, plan slice 10; migration 243).
 *
 * `customer_documents_request_reminder_days` lists the days after a request
 * was made at which a reminder goes out (default "3,7"; empty = off). The
 * days count from ladder_started_at — the request's creation, or its
 * reopening. A run works out how many steps are due by now; when that is
 * more than the reminders already sent it sends ONE mail and marks every
 * due step as done, so a request that fell behind (the job was off, the
 * server was down) catches up with one reminder, not one per hour. Time is
 * compared in JS (toMillis): timestamps are a Date on PostgreSQL and text on
 * SQLite.
 *
 * Nothing is sent, and no step used up, while the documents feature is off
 * (globally or for the customer) or the ladder setting is empty.
 *
 * The step is claimed with a conditional update on reminder_count
 * (WHERE reminder_count = n AND status = 'open'), so several replicas send
 * it once, and a request fulfilled or cancelled in the meantime gets none.
 * The mail itself goes through the email queue (queueEmail writes the due
 * time the way each engine reads it back).
 */

const { scheduledTask } = require('./scheduledTask');
const { db, logActivity } = require('../database/db');
const logger = require('../utils/logger');
const { getAppSetting } = require('../utils/appSettings');
const { toMillis } = require('../utils/queueTimestamps');
const customerDocumentNotifications = require('./customerDocumentNotifications');
const customerAccountsService = require('./customerAccountsService');
const { isFeatureEnabled } = require('../middleware/requireFeatureFlag');

const DAY_MS = 24 * 60 * 60 * 1000;

const task = scheduledTask(runDocumentRequestReminders, { schedule: '50 * * * *' });
function startDocumentRequestReminders() { task.start(); }
const stopDocumentRequestReminders = () => task.stop();

/** "3, 7" → [3, 7]; anything unreadable is dropped, the rest sorted. */
function parseLadder(value) {
  return String(value == null ? '' : value)
    .split(/[,;\s]+/)
    .map((v) => Number(v))
    .filter((n) => Number.isFinite(n) && n > 0 && n <= 3650)
    .map((n) => Math.floor(n))
    .sort((a, b) => a - b)
    .filter((n, i, all) => all.indexOf(n) === i);
}

async function runDocumentRequestReminders(now = Date.now()) {
  const sent = { reminded: 0 };
  if (!(await isFeatureEnabled('documents'))) return sent;
  const ladder = parseLadder(await getAppSetting('customer_documents_request_reminder_days', '3,7'));
  if (ladder.length === 0) return sent;

  const open = await db('customer_document_requests')
    .where({ status: 'open' })
    .where('reminder_count', '<', ladder.length)
    .orderBy('id', 'asc')
    .select('id', 'customer_account_id', 'event_id', 'title', 'note', 'due_at', 'created_at',
      'ladder_started_at', 'reminder_count', 'reminded_at');

  for (const request of open) {
    const step = Number(request.reminder_count) || 0;
    const start = toMillis(request.ladder_started_at) ?? toMillis(request.created_at);
    if (start === null) continue;
    const due = ladder.filter((days) => now - start >= days * DAY_MS).length;
    if (due <= step) continue;

    // Documents off for this customer: leave the step for when it is on.
    const features = await customerAccountsService.getEffectiveFeaturesForCustomer(request.customer_account_id);
    if (!features || !features.documents) continue;

    const remindedAt = new Date(now).toISOString();
    // ladder_started_at too: a request reopened since this run read it has a
    // new ladder, which this run's arithmetic must not spend.
    const claimed = await db('customer_document_requests')
      .where({ id: request.id, status: 'open', reminder_count: step, ladder_started_at: request.ladder_started_at })
      .update({ reminder_count: due, reminded_at: remindedAt });
    if (claimed !== 1) continue;

    const result = await customerDocumentNotifications.notifyRequest(request, { reminder: true });
    if (result !== 'queued') {
      // Nothing queued (the mail could not be prepared, or the customer is
      // not reachable right now): hand the step back, so a later run sends
      // it instead of the ladder running out unsent. Conditional on this
      // run's claim, so a reopen or another claim since is left alone.
      await db('customer_document_requests')
        .where({ id: request.id, reminder_count: due, reminded_at: remindedAt })
        .update({ reminder_count: step, reminded_at: request.reminded_at || null });
      continue;
    }
    await logActivity('customer_document_request_reminded',
      { requestId: request.id, customerId: request.customer_account_id, step: due },
      request.event_id || null, { type: 'system', name: null });
    sent.reminded += 1;
  }
  if (sent.reminded) logger.info(`Document requests: queued ${sent.reminded} reminder(s)`);
  return sent;
}

module.exports = {
  startDocumentRequestReminders,
  stopDocumentRequestReminders,
  runDocumentRequestReminders,
  _internal: { parseLadder },
};
