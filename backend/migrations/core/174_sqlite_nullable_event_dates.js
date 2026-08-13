/**
 * Migration 174: make events.event_date / events.expires_at nullable on SQLite (#1029).
 *
 * Migration 061 introduced the `event_require_event_date` /
 * `event_require_expiration` settings and dropped the NOT NULL on both columns
 * — but only for Postgres. It skipped SQLite on the premise that "SQLite
 * doesn't enforce NOT NULL as strictly", which is simply untrue: clearing the
 * expiration on a SQLite install fails with
 *
 *     SQLITE_CONSTRAINT: NOT NULL constraint failed: events.expires_at
 *
 * so "never expires" has never been reachable there. This finishes 061 for
 * SQLite. Knex implements .alter() on SQLite by recreating the table; migration
 * 073 already does exactly that on `events`, so the path is well-trodden here.
 *
 * Postgres is skipped — 061 already handled it, and knex's .alter() rewrites
 * the whole column definition (type, default, nullability), which would be a
 * needless rewrite of a column that is already correct.
 */

function isSqlite(knex) {
  const client = knex.client.config.client;
  return client === 'sqlite3' || client === 'better-sqlite3';
}

exports.up = async function(knex) {
  if (!isSqlite(knex)) return;

  const hasEvents = await knex.schema.hasTable('events');
  if (!hasEvents) return;

  await knex.schema.alterTable('events', (table) => {
    table.datetime('event_date').nullable().alter();
    table.datetime('expires_at').nullable().alter();
  });
};

exports.down = async function(knex) {
  // Deliberately irreversible. Restoring NOT NULL would fail on any install
  // that has since created a gallery without an expiration — exactly what this
  // migration enables — and 061's down() takes the same position for Postgres.
};
