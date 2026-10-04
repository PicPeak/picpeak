'use strict';

/**
 * Migration 263: rewrite SQLite expires_at text that julianday() cannot read
 * (issue 1733).
 *
 * whereTimestamp / sqliteTimestampMs read expires_at as epoch ms whatever
 * shape it was stored in, via julianday() for text. The PUT validator used
 * to accept any isISO8601() form and store it verbatim, and SQLite's date
 * parser does not know some of them (a compact `+0200` offset, the basic
 * format without separators). Such rows would now fall out of every expiry
 * comparison — the expiring filter, the dashboard tile, the checker — so
 * they are canonicalised to toISOString() once here. Values Date cannot
 * parse either (the jest/sqlite3 "[object Object]" landmine, free text) are
 * left as they are and logged; they were unreadable before as well.
 *
 * PostgreSQL has a timestamp column and nothing to rewrite.
 */

exports.up = async function up(knex) {
  if (knex.client.config.client === 'pg') return;
  if (!(await knex.schema.hasTable('events'))) return;
  if (!(await knex.schema.hasColumn('events', 'expires_at'))) return;

  const rows = await knex('events')
    .select('id', 'expires_at')
    .whereRaw('typeof(expires_at) = \'text\' AND julianday(expires_at) IS NULL');

  let rewritten = 0;
  const unreadable = [];
  for (const row of rows) {
    const parsed = new Date(row.expires_at);
    if (Number.isNaN(parsed.getTime())) {
      unreadable.push(row.id);
      continue;
    }
    await knex('events').where({ id: row.id }).update({ expires_at: parsed.toISOString() });
    rewritten += 1;
  }

  if (rewritten || unreadable.length) {
    // eslint-disable-next-line no-console -- migration output, as in the other core migrations
    console.log(`Migration 263: ${rewritten} expires_at value(s) rewritten in canonical ISO form`
      + (unreadable.length ? `; left unreadable on events ${unreadable.join(', ')}` : ''));
  }
};

// The original text is not kept, and the canonical form is what every
// writer produces now; there is nothing to go back to.
exports.down = async function down() {};
