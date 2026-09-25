/**
 * Reading email_queue timestamps back, whatever shape the engine stored them in.
 *
 * The columns are written three different ways and read back three different
 * ways, and a comparison that assumes one of them is wrong for the other two:
 *
 *   - Postgres hands back a Date.
 *   - SQLite stores what queueEmail writes -- a JS Date, which the native
 *     binding turns into epoch ms -- and hands back that number.
 *   - Both columns also default to CURRENT_TIMESTAMP, which on SQLite is a
 *     zone-less 'YYYY-MM-DD HH:MM:SS' string in UTC, and older rows plus test
 *     fixtures carry ISO strings.
 *
 * Extracted from adminSystemHealth so the parsing can be tested under a forced
 * TZ in a child process, which is the only way to pin the naive-timestamp case
 * from a test suite that itself runs in UTC (#1262).
 */

/** 'YYYY-MM-DD HH:MM:SS[.sss]' with no zone — SQLite's CURRENT_TIMESTAMP shape. */
const SQLITE_NAIVE_TIMESTAMP = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?$/;

/**
 * @param {Date|number|string|null|undefined} value
 * @returns {number|null} epoch ms, or null when the value cannot be read
 */
function toMillis(value) {
  if (value == null) return null;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  const text = String(value).trim();
  if (text === '') return null;
  // A numeric string is epoch ms; anything else goes through Date.parse.
  const numeric = Number(text);
  if (Number.isFinite(numeric)) return numeric;
  // Date.parse reads the zone-less shape as LOCAL time. On a
  // TZ=America/New_York deployment that puts a row due now four hours in the
  // future, so it never reaches the waiting list -- the false all-clear again,
  // arrived at via the clock. Stamp the zone the value actually carries.
  const stamped = SQLITE_NAIVE_TIMESTAMP.test(text) ? `${text.replace(' ', 'T')}Z` : text;
  const parsed = Date.parse(stamped);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * A timestamp to WRITE into email_queue: a Date on Postgres, epoch ms on
 * SQLite — the shape the processor's `scheduled_at <= ?` bind takes there
 * (issue 1670). A raw number on SQLite also sidesteps the jest/sqlite3
 * landmine in CLAUDE.md, where a sandbox-created Date is stored as the
 * literal string "[object Object]".
 */
function queueTimestamp(ms) {
  return require('./dbCompat').isPostgreSQL() ? new Date(ms) : ms;
}

const STALE_AFTER_MS = 24 * 60 * 60 * 1000;
const STALE_MESSAGE = 'Never picked up: scheduled_at was stored as text on SQLite (issue 1670). '
  + 'Retry from System health → Failures if it is still wanted.';

// SQLite's strftime('%s') parses both CURRENT_TIMESTAMP's 'YYYY-MM-DD HH:MM:SS'
// and an ISO 'YYYY-MM-DDTHH:MM:SS.SSSZ', and returns NULL for anything else.
const sqliteMillis = (column) => `CAST(strftime('%s', ${column}) AS INTEGER) * 1000`;

/**
 * Make text timestamps in email_queue due on SQLite (issue 1670). Shared by
 * migration 236 and the .picpeak import, which batch-inserts archived rows as
 * they were and would otherwise bring the stuck shape back after the
 * migration has run. No-op on Postgres and without the table. Idempotent.
 *
 *   1. a pending row that never came due and has been waiting more than a
 *      day is parked as `failed` with a reason — a gallery welcome or an
 *      expiry warning delivered months late would do more harm than good; it
 *      stays visible under System health → Failures, whose retry route
 *      re-queues it. Only the column default's own shape ('YYYY-MM-DD
 *      HH:MM:SS', no zone) is a row that never came due: an ISO string is a
 *      Postgres-sourced archive's legitimate schedule (or a shape that came
 *      due there), and a number was due and unsent for some other reason
 *      (SMTP down, retries exhausted). Neither is parked;
 *   2. every text scheduled_at / created_at becomes epoch milliseconds;
 *   3. a text scheduled_at strftime cannot read becomes NULL — the row was
 *      meant to send at once, which is what leaving the default meant.
 *
 * @param {import('knex').Knex|import('knex').Knex.Transaction} knex
 */
async function normaliseSqliteEmailQueue(knex, { now = Date.now() } = {}) {
  if (!(knex.client.config.client || '').toLowerCase().includes('sqlite')) return;
  if (!(await knex.schema.hasTable('email_queue'))) return;
  if (!(await knex.schema.hasColumn('email_queue', 'scheduled_at'))) return;

  // CURRENT_TIMESTAMP's shape and no other: a space between date and time,
  // no 'T', no zone. SQLITE_NAIVE_TIMESTAMP, as a GLOB.
  const NAIVE_GLOB = '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9] [0-9][0-9]:[0-9][0-9]:[0-9][0-9]*';
  await knex.raw(
    'UPDATE email_queue SET status = ?, error_message = ? '
    + 'WHERE status = \'pending\' AND typeof(scheduled_at) = \'text\' AND scheduled_at GLOB ? '
    + `AND ${sqliteMillis('scheduled_at')} < ?`,
    ['failed', STALE_MESSAGE, NAIVE_GLOB, now - STALE_AFTER_MS],
  );
  for (const column of ['scheduled_at', 'created_at']) {
    if (!(await knex.schema.hasColumn('email_queue', column))) continue;
    await knex.raw(
      `UPDATE email_queue SET ${column} = ${sqliteMillis(column)} `
      + `WHERE typeof(${column}) = 'text' AND strftime('%s', ${column}) IS NOT NULL`,
    );
  }
  await knex.raw('UPDATE email_queue SET scheduled_at = NULL WHERE typeof(scheduled_at) = \'text\'');
}

module.exports = {
  toMillis, SQLITE_NAIVE_TIMESTAMP, queueTimestamp, normaliseSqliteEmailQueue, STALE_AFTER_MS, STALE_MESSAGE,
};
