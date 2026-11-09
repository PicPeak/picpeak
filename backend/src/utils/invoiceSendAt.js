/**
 * invoices.scheduled_send_at as ISO text on SQLite.
 *
 * The invoice create paths once wrote the send date as a Date, which SQLite
 * stores as epoch milliseconds, and the update route wrote the editor's
 * zone-less 'YYYY-MM-DDTHH:mm'. The scheduler compares the column with ISO
 * text, and SQLite sorts every number before every text, so a number counts
 * as due whatever date it holds. This rewrites both shapes as
 * 'YYYY-MM-DDTHH:MM:SS.sssZ' (toStoredTimestamp in dateNormalize writes the
 * same):
 *   - a number: epoch milliseconds, or seconds below 1e11, the split the
 *     portable import's epochToIso uses;
 *   - text without a 'Z': read as UTC, as toTimestamp reads a zone-less
 *     value and as the editor shows the stored one. Text that is not a
 *     date ('YYYY-MM-DD...') or that SQLite cannot read stays as it is.
 *
 * Zone-less text was the editor's: the scheduler never found it due, so a
 * scheduled invoice holding a past one was stuck, never sent. Sending it
 * now would mail it to the customer however late it is. Such an invoice is
 * held as a draft instead (scheduled, no send date, as the bills list shows
 * "Draft"), and the admin sends it or gives it a new date. The count is
 * logged.
 *
 * Run once by migration 356, and again by the portable import, whose
 * archived rows may predate that migration while the target's ledger says it
 * has run (costTimestamps does the same for migration 337). The SQL is raw
 * because typeof() and strftime() have no knex builder. PostgreSQL has a
 * typed timestamp column and is never touched. A second run changes nothing.
 */

const ISO = '%Y-%m-%dT%H:%M:%fZ';

const ZONELESS = `typeof(scheduled_send_at) = 'text' AND scheduled_send_at NOT LIKE '%Z'
  AND scheduled_send_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'`;

/**
 * @param {import('knex').Knex} knex connection or transaction
 * @returns {Promise<number>} stuck invoices held as drafts
 */
async function isoSqliteInvoiceSendAt(knex) {
  if (knex.client.config.client === 'pg') return 0;
  if (!(await knex.schema.hasTable('invoices'))) return 0;
  if (!(await knex.schema.hasColumn('invoices', 'scheduled_send_at'))) return 0;
  const held = await knex('invoices')
    .where({ status: 'scheduled' })
    .whereRaw(ZONELESS)
    .whereRaw(`strftime('${ISO}', scheduled_send_at) <= strftime('${ISO}', 'now')`)
    .update({ scheduled_send_at: null });
  if (held) {
    require('./logger').warn(`invoices: held ${held} scheduled invoice(s) as drafts whose edited send date had passed`
      + ' without sending; send each one or give it a new date');
  }
  await knex.raw(
    `UPDATE invoices SET scheduled_send_at = strftime('${ISO}',
       CASE WHEN abs(scheduled_send_at) < 1e11 THEN scheduled_send_at ELSE scheduled_send_at / 1000.0 END,
       'unixepoch')
     WHERE typeof(scheduled_send_at) IN ('integer', 'real')`
  );
  await knex.raw(
    `UPDATE invoices SET scheduled_send_at = COALESCE(strftime('${ISO}', scheduled_send_at), scheduled_send_at)
     WHERE ${ZONELESS}`
  );
  return held;
}

module.exports = { isoSqliteInvoiceSendAt };
