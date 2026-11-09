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
 *     value and as the editor shows the stored one;
 *   - anything else (an API client's '' or text that is no date) becomes
 *     NULL. The invoice page already showed such an invoice as a draft, and
 *     as text it would now compare as due.
 *
 * Zone-less text was the editor's: the scheduler never found it due, so a
 * scheduled invoice holding a past one was stuck, never sent. Sending it
 * now would mail it to the customer however late it is. Such an invoice is
 * held as a draft instead (scheduled, no send date, as the bills list shows
 * "Draft"), and the admin sends it or gives it a new date. It is then a
 * draft like any other: its hours and expenses unlock, and a product order
 * may extend it when it is the only matching draft. The change goes through
 * auditedUpdate, so the invoice's history names it, and the count is logged.
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
const NOT_ISO = `typeof(scheduled_send_at) = 'text'
  AND scheduled_send_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'`;

async function holdStuckInvoices(knex) {
  const ids = (await knex('invoices')
    .where({ status: 'scheduled' })
    .whereRaw(ZONELESS)
    .whereRaw(`strftime('${ISO}', scheduled_send_at) <= strftime('${ISO}', 'now')`)
    .select('id')).map((row) => row.id);
  if (ids.length === 0) return 0;
  const where = (q) => q.whereIn('id', ids);
  if (await knex.schema.hasTable('accounting_change_history')) {
    // Required here: the migration test runs without the app's database.
    const { auditedUpdate } = require('../services/accountingHistory');
    await auditedUpdate(knex, 'invoices', where, { scheduled_send_at: null },
      { actor: 'upgrade', source: 'invoice.sendAt.holdStuck' });
  } else {
    await where(knex('invoices')).update({ scheduled_send_at: null });
  }
  require('./logger').warn(`invoices: held ${ids.length} scheduled invoice(s) as drafts whose edited send date had`
    + ` passed without sending (ids ${ids.join(', ')}); send each one or give it a new date`);
  return ids.length;
}

/**
 * @param {import('knex').Knex} knex connection or transaction
 * @returns {Promise<number>} stuck invoices held as drafts
 */
async function isoSqliteInvoiceSendAt(knex) {
  if (knex.client.config.client === 'pg') return 0;
  if (!(await knex.schema.hasTable('invoices'))) return 0;
  if (!(await knex.schema.hasColumn('invoices', 'scheduled_send_at'))) return 0;
  const held = await holdStuckInvoices(knex);
  await knex.raw(
    `UPDATE invoices SET scheduled_send_at = strftime('${ISO}',
       CASE WHEN abs(scheduled_send_at) < 1e11 THEN scheduled_send_at ELSE scheduled_send_at / 1000.0 END,
       'unixepoch')
     WHERE typeof(scheduled_send_at) IN ('integer', 'real')`
  );
  await knex.raw(
    `UPDATE invoices SET scheduled_send_at = strftime('${ISO}', scheduled_send_at)
     WHERE ${ZONELESS}`
  );
  await knex.raw(`UPDATE invoices SET scheduled_send_at = NULL WHERE ${NOT_ISO}`);
  return held;
}

module.exports = { isoSqliteInvoiceSendAt };
