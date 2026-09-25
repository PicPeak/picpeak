'use strict';

/**
 * Migration 256: make the email queue's stuck rows due on SQLite (issue 1670).
 *
 * `email_queue.scheduled_at` defaults to CURRENT_TIMESTAMP. On PostgreSQL that
 * is a timestamp and the processor's `scheduled_at <= now()` finds it. On
 * SQLite it is the text '2026-09-25 08:57:45' in a column the processor
 * compares against a number (the driver binds a Date as epoch milliseconds),
 * and SQLite orders every number below every text — so a row that was left to
 * the default was never picked up. Every writer that did not set the column
 * (queueEmail's ordinary path, the gallery_created inserts, the project
 * resend) produced such a row; only rows written with an explicit millisecond
 * or Date value (newsletters, business-hours floors, split invoices) ever
 * came due. The single-container image runs SQLite by default.
 *
 * The writers now store an explicit NULL. This migration takes care of the
 * rows already there, on SQLite only:
 *
 *   1. every text `scheduled_at` / `created_at` becomes epoch milliseconds,
 *      the shape the processor compares against and the newsletter code
 *      already writes;
 *   2. a pending row that has been waiting for more than a day is marked
 *      `failed` with an explanation, not sent: a gallery welcome or an expiry
 *      warning delivered months late would do more harm than good. It stays
 *      visible under System health → Failures, where the retry route re-queues
 *      it on request;
 *   3. a pending row younger than that is left due, and goes out on the next
 *      processor run.
 *
 * Irreversible by design: the text values are not kept, and there is nothing
 * to restore them for.
 */

const STALE_AFTER_MS = 24 * 60 * 60 * 1000;
const STALE_MESSAGE = 'Never picked up: scheduled_at was stored as text on SQLite (issue 1670). '
  + 'Retry from System health → Failures if it is still wanted.';

function isSqlite(knex) {
  return (knex.client.config.client || '').toLowerCase().includes('sqlite');
}

// SQLite's strftime('%s') parses both CURRENT_TIMESTAMP's 'YYYY-MM-DD HH:MM:SS'
// and an ISO 'YYYY-MM-DDTHH:MM:SS.SSSZ', and returns NULL for anything else.
const toMillis = (column) => `CAST(strftime('%s', ${column}) AS INTEGER) * 1000`;

exports.up = async function up(knex) {
  if (!isSqlite(knex)) return;
  if (!(await knex.schema.hasTable('email_queue'))) return;
  if (!(await knex.schema.hasColumn('email_queue', 'scheduled_at'))) return;

  // 2. first, while the text shape still identifies the stuck rows: a row
  //    that never came due and has been waiting more than a day. A pending
  //    row that already holds a number was due and unsent for some other
  //    reason (SMTP down, retries exhausted) and is not this migration's.
  const cutoff = Date.now() - STALE_AFTER_MS;
  await knex.raw(
    'UPDATE email_queue SET status = ?, error_message = ? '
    + `WHERE status = 'pending' AND typeof(scheduled_at) = 'text' AND ${toMillis('scheduled_at')} < ?`,
    ['failed', STALE_MESSAGE, cutoff],
  );

  // 1. the shape.
  for (const column of ['scheduled_at', 'created_at']) {
    if (!(await knex.schema.hasColumn('email_queue', column))) continue;
    await knex.raw(
      `UPDATE email_queue SET ${column} = ${toMillis(column)} `
      + `WHERE typeof(${column}) = 'text' AND strftime('%s', ${column}) IS NOT NULL`,
    );
  }
  // A text value strftime could not read: the row was meant to send at once
  // (that is what leaving the default meant), so let it.
  await knex.raw('UPDATE email_queue SET scheduled_at = NULL WHERE typeof(scheduled_at) = \'text\'');

  // Idempotent: a second run finds no text values and changes nothing.
};

exports.down = async function down() {
  // Data normalisation; the text shapes are gone and were never correct.
};

exports.STALE_AFTER_MS = STALE_AFTER_MS;
exports.STALE_MESSAGE = STALE_MESSAGE;
