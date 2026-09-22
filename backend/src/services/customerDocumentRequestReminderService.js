/**
 * customerDocumentRequestReminderService — the reminder ladder for open
 * document requests (#1444, plan slice 10; migration 243).
 *
 * `customer_documents_request_reminder_days` lists the days after a request
 * was made at which a reminder goes out (default "3,7"; empty = off). A
 * request is due for step n+1 when it has had n reminders and
 * now - created_at has passed the (n+1)th day count. Time is compared in JS
 * (toMillis): created_at is a Date on PostgreSQL and text on SQLite.
 *
 * Each step is claimed with a conditional update on reminder_count
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
  const ladder = parseLadder(await getAppSetting('customer_documents_request_reminder_days', '3,7'));
  const sent = { reminded: 0 };
  if (ladder.length === 0) return sent;

  const open = await db('customer_document_requests')
    .where({ status: 'open' })
    .where('reminder_count', '<', ladder.length)
    .orderBy('id', 'asc')
    .select('id', 'customer_account_id', 'event_id', 'title', 'note', 'due_at', 'created_at', 'reminder_count');

  for (const request of open) {
    const step = Number(request.reminder_count) || 0;
    const created = toMillis(request.created_at);
    if (created === null || now - created < ladder[step] * DAY_MS) continue;

    const claimed = await db('customer_document_requests')
      .where({ id: request.id, status: 'open', reminder_count: step })
      .update({ reminder_count: step + 1, reminded_at: new Date(now).toISOString() });
    if (claimed !== 1) continue;

    const result = await customerDocumentNotifications.notifyRequest(request, { reminder: true });
    await logActivity('customer_document_request_reminded',
      { requestId: request.id, customerId: request.customer_account_id, step: step + 1 },
      request.event_id || null, { type: 'system', name: null });
    if (result === 'queued') sent.reminded += 1;
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
