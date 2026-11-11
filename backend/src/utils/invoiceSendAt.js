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
 * timestamp column and is never touched here; for a SQLite archive restored
 * onto it, holdPassedPgSendDates below does step 1. A second run changes
 * nothing.
 */

const ISO = '%Y-%m-%dT%H:%M:%fZ';
const CANONICAL = '\'[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z\'';

async function clearSendDates(knex, ids, actor, source, values = {}) {
  if (ids.length === 0) return;
  // Required here: utils load before the services, and the migration test
  // runs without the app's database.
  const { auditedUpdate } = require('../services/accountingHistory');
  await auditedUpdate(knex, 'invoices', (q) => q.whereIn('id', ids), { scheduled_send_at: null, ...values }, { actor, source });
}

// Migration 358's marker on a held invoice: the automatic product append
// leaves it alone until the admin sends it or gives it a new date (issue
// 2456). Migration 356 runs before the column exists and leaves it unset;
// 358 marks those invoices from their history (markHeldInvoices).
const heldMarker = (markHeld) => (markHeld ? { send_held_at: new Date().toISOString() } : {});

function warnHeld(held) {
  if (!held.length) return;
  require('./logger').warn(`invoices: held ${held.length} scheduled invoice(s) as drafts whose send date had passed without`
    + ` sending (ids ${held.join(', ')}); send each one or give it a new date`);
}

const idsWhere = async (knex, sql) => (await knex('invoices')
  .whereRaw(sql).select('id').orderBy('id')).map((row) => row.id);

/**
 * @param {import('knex').Knex} knex connection or transaction
 * @param {{ actor?: string, markHeld?: boolean }} [options] history actor: "upgrade" or "import";
 *   markHeld sets migration 358's send_held_at on the held invoices
 * @returns {Promise<{ held: number[], cleared: number[] }>} ids held as drafts, and ids whose text was no date
 */
async function isoSqliteInvoiceSendAt(knex, { actor = 'upgrade', markHeld = false } = {}) {
  const none = { held: [], cleared: [] };
  if (knex.client.config.client === 'pg') return none;
  if (!(await knex.schema.hasTable('invoices'))) return none;
  if (!(await knex.schema.hasColumn('invoices', 'scheduled_send_at'))) return none;

  const held = await idsWhere(knex, `status = 'scheduled' AND typeof(scheduled_send_at) = 'text'
    AND strftime('${ISO}', scheduled_send_at) <= strftime('${ISO}', 'now')`);
  await clearSendDates(knex, held, actor, 'invoice.sendAt.holdStuck', heldMarker(markHeld));
  const cleared = await idsWhere(knex, `typeof(scheduled_send_at) = 'text'
    AND strftime('${ISO}', scheduled_send_at) IS NULL`);
  await clearSendDates(knex, cleared, actor, 'invoice.sendAt.notADate');

  await knex.raw(`UPDATE invoices SET scheduled_send_at = strftime('${ISO}',
       CASE WHEN abs(scheduled_send_at) < 1e11 THEN scheduled_send_at ELSE scheduled_send_at / 1000.0 END, 'unixepoch')
     WHERE typeof(scheduled_send_at) IN ('integer', 'real')`);
  await knex.raw(`UPDATE invoices SET scheduled_send_at = strftime('${ISO}', scheduled_send_at)
     WHERE typeof(scheduled_send_at) = 'text' AND scheduled_send_at NOT GLOB ${CANONICAL}`);

  warnHeld(held);
  if (cleared.length) {
    require('./logger').warn(`invoices: cleared a send date that was no date on ${cleared.length} invoice(s) (ids ${cleared.join(', ')})`);
  }
  return { held, cleared };
}

/**
 * Step 1 for a SQLite archive from before 356 restored onto PostgreSQL (issue
 * 2459). The import's coercion has already made its send dates timestamps,
 * so the stuck ones can no longer be told apart by their text: every
 * scheduled invoice whose send date has passed is held, as the source never
 * sent it. Marked like the SQLite path's holds.
 *
 * @param {import('knex').Knex} knex connection or transaction
 * @param {{ actor?: string }} [options] history actor
 * @returns {Promise<number[]>} ids held as drafts
 */
async function holdPassedPgSendDates(knex, { actor = 'import' } = {}) {
  if (knex.client.config.client !== 'pg') return [];
  const held = (await knex('invoices').where({ status: 'scheduled' })
    .where('scheduled_send_at', '<=', knex.fn.now()).select('id').orderBy('id')).map((row) => row.id);
  await clearSendDates(knex, held, actor, 'invoice.sendAt.holdStuck', heldMarker(true));
  warnHeld(held);
  return held;
}

const HOLD_SOURCE = 'invoice.sendAt.holdStuck';
const parsedChanges = (row) => (typeof row.changes === 'string' ? JSON.parse(row.changes) : row.changes) || {};

/**
 * Migration 358's backfill: set send_held_at on the invoices a hold above
 * left as drafts before the column existed. They are found by the hold's
 * history row (source invoice.sendAt.holdStuck); an invoice whose send date
 * or status changed after it, or that was sent, is no longer held and stays
 * unmarked. The marker is the time of the hold. Also run by the portable
 * import for an archive made before 358. A second run changes nothing.
 *
 * @param {import('knex').Knex} knex connection or transaction
 * @param {{ actor?: string }} [options] history actor: "upgrade" or "import"
 * @returns {Promise<number[]>} ids marked
 */
async function markHeldInvoices(knex, { actor = 'upgrade' } = {}) {
  if (!(await knex.schema.hasTable('accounting_change_history'))) return [];
  if (!(await knex.schema.hasColumn('invoices', 'send_held_at'))) return [];
  const history = (q) => q('accounting_change_history').where({ entity_type: 'invoice', action: 'updated' });
  const holdRows = await history(knex).where({ source: HOLD_SOURCE }).select('id', 'entity_id', 'created_at').orderBy('id');
  if (holdRows.length === 0) return [];
  // The last hold of each invoice, and whether its send date or status
  // changed after it.
  const holds = new Map(holdRows.map((row) => [Number(row.entity_id), { historyId: row.id, at: row.created_at }]));
  const held = [...holds.keys()];
  for (let i = 0; i < held.length; i += 400) {
    const later = await history(knex).whereIn('entity_id', held.slice(i, i + 400))
      .where('id', '>', holdRows[0].id).select('id', 'entity_id', 'changes');
    for (const row of later) {
      const hold = holds.get(Number(row.entity_id));
      if (!hold || row.id <= hold.historyId) continue;
      const changes = parsedChanges(row);
      if ('scheduled_send_at' in changes || 'status' in changes) holds.delete(Number(row.entity_id));
    }
  }
  const ids = [...holds.keys()];
  if (ids.length === 0) return [];
  const { toStoredTimestamp } = require('./dateNormalize');
  const { auditedUpdate } = require('../services/accountingHistory');
  const marked = [];
  for (const row of await knex('invoices').whereIn('id', ids).where({ status: 'scheduled' })
    .whereNull('scheduled_send_at').whereNull('sent_at').whereNull('send_held_at').select('id').orderBy('id')) {
    const at = toStoredTimestamp(holds.get(Number(row.id)).at) || new Date().toISOString();
    await auditedUpdate(knex, 'invoices', { id: row.id }, { send_held_at: at }, { actor, source: 'invoice.sendAt.markHeld' });
    marked.push(row.id);
  }
  return marked;
}

module.exports = { isoSqliteInvoiceSendAt, holdPassedPgSendDates, markHeldInvoices };
