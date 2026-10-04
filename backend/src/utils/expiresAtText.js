/**
 * events.expires_at as TEXT on SQLite (issue 1733).
 *
 * whereTimestamp / sqliteTimestampMs read a text expires_at through
 * julianday(), which treats a zone-less value as UTC and returns NULL for the
 * ISO forms it does not know (a compact `+0200` offset, the basic format).
 * Everything that writes or rewrites such text goes through here so the
 * parser and the reader agree:
 *
 *   - parseExpiresAtText: the PUT handler's canonicalisation. Date.parse
 *     reads a zone-less date-time as LOCAL time, which on a TZ=Europe/Berlin
 *     server would shift the value by hours against what julianday() and the
 *     already stored zone-less rows mean; the zone is stamped as UTC first.
 *   - canonicaliseSqliteExpiresAt: rewrites the rows julianday() cannot read.
 *     Run once by migration 263 and again by the .picpeak import, which
 *     re-inserts archived rows verbatim on a target where 263 already ran.
 */

// 'YYYY-MM-DD HH:MM[:SS[.sss]]' or with a 'T', no zone.
const ZONELESS_DATETIME = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/;

/**
 * @param {unknown} value
 * @returns {Date|null} the instant, or null when the value is not a readable date-time
 */
function parseExpiresAtText(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text) return null;
  const stamped = ZONELESS_DATETIME.test(text) ? `${text.replace(' ', 'T')}Z` : text;
  const parsed = new Date(stamped);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Rewrite every text expires_at that julianday() cannot read as toISOString().
 * SQLite only; a no-op elsewhere and on a schema without the column.
 *
 * @param {import('knex').Knex} knex connection or transaction
 * @returns {Promise<{ rewritten: number, unreadable: number[] }>}
 */
async function canonicaliseSqliteExpiresAt(knex) {
  const result = { rewritten: 0, unreadable: [] };
  if (knex.client.config.client === 'pg') return result;
  if (!(await knex.schema.hasTable('events'))) return result;
  if (!(await knex.schema.hasColumn('events', 'expires_at'))) return result;

  const rows = await knex('events')
    .select('id', 'expires_at')
    .whereRaw('typeof(expires_at) = \'text\' AND julianday(expires_at) IS NULL');
  for (const row of rows) {
    const parsed = parseExpiresAtText(row.expires_at);
    if (!parsed) {
      result.unreadable.push(row.id);
      continue;
    }
    await knex('events').where({ id: row.id }).update({ expires_at: parsed.toISOString() });
    result.rewritten += 1;
  }
  return result;
}

module.exports = { parseExpiresAtText, canonicaliseSqliteExpiresAt };
