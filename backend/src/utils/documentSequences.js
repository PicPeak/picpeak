/**
 * documentSequences — atomic gap-free sequence generator for CRM
 * document numbers (invoices, quotes, contracts, future doc kinds).
 *
 * **Contract**: `claimNextSequence(kind, year, [trx])` returns the
 * next integer in the (kind, year) series. Atomic against concurrent
 * callers: two simultaneous claims for the same row return strictly
 * increasing values, no collisions, no gaps.
 *
 * **How the atomicity works**
 *
 * Postgres: a single `UPDATE … SET current_value = current_value + 1
 * WHERE kind = ? AND year = ? RETURNING current_value` holds a row
 * lock for the duration of the statement; concurrent callers
 * serialize on the lock.
 *
 * SQLite: knex does not expose `BEGIN IMMEDIATE` declaratively, but
 * SQLite's default journal mode (or WAL) gives us per-row serialization
 * via the transaction. We wrap the UPDATE + re-SELECT in a transaction
 * which acquires the write lock; concurrent transactions queue.
 *
 * **First-claim path** (no row yet for the (kind, year))
 *
 * Migration 132 seeded rows for every existing year via MAX(...)
 * backfill. New years need an INSERT on first use. We do an
 * INSERT-OR-IGNORE then UPDATE … RETURNING. Both steps are inside
 * the same transaction so the year row is guaranteed to exist when
 * the UPDATE fires.
 */

const { db } = require('../database/db');
const { AppError } = require('./errors');

/**
 * Claim the next sequence value for (kind, year). Returns the new
 * integer. Throws AppError on DB failure; caller composes the
 * formatted document number from this integer via formatNumberInTemplate.
 *
 * @param {string} kind   'invoice' | 'quote' | 'contract' | ...
 * @param {number} year   4-digit year
 * @param {object} [trx]  optional knex transaction. When supplied the
 *                        claim joins the caller's transaction so the
 *                        sequence increment and the row INSERT can
 *                        commit-or-roll-back together. Otherwise we
 *                        run our own micro-transaction.
 */
async function claimNextSequence(kind, year, trx) {
  if (!kind || typeof kind !== 'string') {
    throw new AppError('claimNextSequence: kind required', 500);
  }
  const yr = parseInt(year, 10);
  if (!Number.isFinite(yr)) {
    throw new AppError('claimNextSequence: invalid year', 500);
  }

  const exec = async (q) => {
    // Step 1: ensure the (kind, year) row exists. INSERT...ON CONFLICT
    // DO NOTHING is the Postgres-native form; SQLite supports the same
    // syntax (3.24+). knex's `onConflict('...').ignore()` paves over
    // the differences.
    await q('document_sequences')
      .insert({
        kind, year: yr, current_value: 0,
        created_at: new Date(), updated_at: new Date(),
      })
      .onConflict(['kind', 'year']).ignore();

    // Step 2: atomic claim. We do UPDATE … (no RETURNING because
    // knex's returning() is uneven across drivers) then re-SELECT.
    // The transaction wrapper (or the caller's trx) keeps the two
    // statements on the same row lock, so concurrent claimers
    // serialize.
    await q('document_sequences')
      .where({ kind, year: yr })
      .increment('current_value', 1)
      .update({ updated_at: new Date() });
    const row = await q('document_sequences')
      .where({ kind, year: yr })
      .select('current_value')
      .first();
    if (!row) {
      throw new AppError(`claimNextSequence: row vanished for ${kind}/${yr}`, 500);
    }
    return row.current_value;
  };

  if (trx) {
    return await exec(trx);
  }
  return await db.transaction(async (innerTrx) => exec(innerTrx));
}

module.exports = { claimNextSequence };
