/**
 * invoices.scheduled_send_at as ISO text on SQLite.
 *
 * The invoice create paths once wrote the send date as a Date, which SQLite
 * stores as epoch milliseconds, and the update route stored whatever ISO 8601
 * text it was given (the editor's zone-less 'YYYY-MM-DDTHH:mm', or an API
 * client's '…Z', '…+01:00', '…000000Z'). The scheduler compares the column
 * with ISO text, and SQLite sorts every number before every text, so the
 * stored values have to be one shape: 'YYYY-MM-DDTHH:MM:SS.sssZ', which
 * toStoredTimestamp in dateNormalize writes too.
 *
 * In order:
 *   1. A scheduled invoice whose send date is text that has already passed
 *      was never sent: the old scheduler compared with a number, which no
 *      text matches. Sending it now would mail it however late it is, so it
 *      is held as a draft instead (scheduled, no send date, as the bills list
 *      shows "Draft"), and the admin sends it or gives it a new date. This
 *      covers the editor's dates and the canonical text a failed "Mark
 *      delivered" send left behind.
 *   2. Text SQLite cannot read as a date ('', 'next week', '2026-W45')
 *      becomes NULL: the invoice page showed it as a draft already, and as
 *      text the scheduler would now find it due.
 *   3. A number becomes the same instant as ISO text: milliseconds, or
 *      seconds below 1e11, the split the portable import's epochToIso uses.
 *   4. Readable text in another shape becomes the same instant as canonical
 *      ISO text. A zone-less value reads as UTC, as toTimestamp reads it and
 *      as the editor shows the stored one.
 * Steps 1 and 2 clear a send date, so they go through auditedUpdate and the
 * invoice's history names them. Steps 3 and 4 change how an instant is
 * stored, not which instant it is; they are the raw statements the
 * accounting history coverage test exempts by their exact form. The SQL is
 * raw because typeof() and strftime() have no knex builder.
 *
 * Run by migration 356 (actor "upgrade"), and by the portable import for an
 * archive that predates 356 (actor "import"), whose rows come back in the old
 * shapes while the target's ledger says 356 has run. PostgreSQL has a typed
 * timestamp column and is never touched. A second run changes nothing.
 */

const ISO = '%Y-%m-%dT%H:%M:%fZ';
const CANONICAL = '\'[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z\'';

async function clearSendDates(knex, ids, actor, source) {
  if (ids.length === 0) return;
  // Required here: utils load before the services, and the migration test
  // runs without the app's database.
  const { auditedUpdate } = require('../services/accountingHistory');
  await auditedUpdate(knex, 'invoices', (q) => q.whereIn('id', ids), { scheduled_send_at: null }, { actor, source });
}

const idsWhere = async (knex, sql) => (await knex('invoices')
  .whereRaw(sql).select('id').orderBy('id')).map((row) => row.id);

/**
 * @param {import('knex').Knex} knex connection or transaction
 * @param {{ actor?: string }} [options] history actor: "upgrade" or "import"
 * @returns {Promise<{ held: number[], cleared: number[] }>} ids held as drafts, and ids whose text was no date
 */
async function isoSqliteInvoiceSendAt(knex, { actor = 'upgrade' } = {}) {
  const none = { held: [], cleared: [] };
  if (knex.client.config.client === 'pg') return none;
  if (!(await knex.schema.hasTable('invoices'))) return none;
  if (!(await knex.schema.hasColumn('invoices', 'scheduled_send_at'))) return none;

  const held = await idsWhere(knex, `status = 'scheduled' AND typeof(scheduled_send_at) = 'text'
    AND strftime('${ISO}', scheduled_send_at) <= strftime('${ISO}', 'now')`);
  await clearSendDates(knex, held, actor, 'invoice.sendAt.holdStuck');
  const cleared = await idsWhere(knex, `typeof(scheduled_send_at) = 'text'
    AND strftime('${ISO}', scheduled_send_at) IS NULL`);
  await clearSendDates(knex, cleared, actor, 'invoice.sendAt.notADate');

  await knex.raw(`UPDATE invoices SET scheduled_send_at = strftime('${ISO}',
       CASE WHEN abs(scheduled_send_at) < 1e11 THEN scheduled_send_at ELSE scheduled_send_at / 1000.0 END, 'unixepoch')
     WHERE typeof(scheduled_send_at) IN ('integer', 'real')`);
  await knex.raw(`UPDATE invoices SET scheduled_send_at = strftime('${ISO}', scheduled_send_at)
     WHERE typeof(scheduled_send_at) = 'text' AND scheduled_send_at NOT GLOB ${CANONICAL}`);

  const logger = require('./logger');
  if (held.length) {
    logger.warn(`invoices: held ${held.length} scheduled invoice(s) as drafts whose send date had passed without`
      + ` sending (ids ${held.join(', ')}); send each one or give it a new date`);
  }
  if (cleared.length) {
    logger.warn(`invoices: cleared a send date that was no date on ${cleared.length} invoice(s) (ids ${cleared.join(', ')})`);
  }
  return { held, cleared };
}

module.exports = { isoSqliteInvoiceSendAt };
