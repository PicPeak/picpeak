'use strict';

/**
 * Migration 238: rewrite SQLite expires_at text that julianday() cannot read
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
 * left as they are and logged; they were unreadable before as well. The
 * .picpeak import runs the same helper on the event rows it brings back.
 *
 * Zone-less text SQLite does read ('2026-10-06 12:00:00', a bare date) is
 * rewritten too, as the UTC instant SQL already takes it for: the JS readers
 * of the column parse such a value as local time, so on a non-UTC server
 * the list and the extend endpoint disagreed with the expiry checker.
 *
 * PostgreSQL has a timestamp column and nothing to rewrite.
 */

const { canonicaliseSqliteExpiresAt } = require('../../src/utils/expiresAtText');

exports.up = async function up(knex) {
  const { rewritten, unreadable } = await canonicaliseSqliteExpiresAt(knex);
  if (rewritten || unreadable.length) {
    // eslint-disable-next-line no-console -- migration output, as in the other core migrations
    console.log(`Migration 238: ${rewritten} expires_at value(s) rewritten in canonical ISO form`
      + (unreadable.length ? `; left unreadable on events ${unreadable.join(', ')}` : ''));
  }
};

// The original text is not kept, and the canonical form is what every
// writer produces now; there is nothing to go back to.
exports.down = async function down() {};
