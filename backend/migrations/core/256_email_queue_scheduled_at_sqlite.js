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
 * rows already there, on SQLite only (normaliseSqliteEmailQueue):
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

const {
  normaliseSqliteEmailQueue, STALE_AFTER_MS, STALE_MESSAGE,
} = require('../../src/utils/queueTimestamps');

// The work itself lives in utils/queueTimestamps so the .picpeak import can
// run it on the rows it batch-inserts after this migration has already run.
exports.up = async function up(knex) {
  await normaliseSqliteEmailQueue(knex);
};

exports.down = async function down() {
  // Data normalisation; the text shapes are gone and were never correct.
};

exports.STALE_AFTER_MS = STALE_AFTER_MS;
exports.STALE_MESSAGE = STALE_MESSAGE;
