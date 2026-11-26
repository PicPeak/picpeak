/**
 * Database Compatibility Utilities
 * Handles differences between PostgreSQL and SQLite
 */

/**
 * Get database client type
 * @returns {string} 'pg' or 'sqlite3'
 */
function getDbClient() {
  return process.env.DATABASE_CLIENT || 'sqlite3';
}

/**
 * Check if using PostgreSQL
 * @returns {boolean}
 */
function isPostgreSQL() {
  return getDbClient() === 'pg';
}

const TIMESTAMP_OPERATORS = new Set(['<', '<=', '>', '>=']);

/**
 * Compare a timestamp column against a point in time, whatever shape the
 * engine stored it in. Use with knex `.modify()`:
 *
 *   db('events').modify(whereTimestamp, 'expires_at', '<=', new Date())
 *
 * PostgreSQL has a timestamp column, so the plain comparison is right. SQLite
 * holds whatever the writer bound: ISO text (`toISOString()`), a date-only or
 * zone-less 'YYYY-MM-DD HH:MM:SS' string, or epoch ms where a Date was
 * written. A bound Date is a number there, and SQLite orders every number
 * below every text, so `expires_at <= ?` never matched a text row and
 * `expires_at > ?` always did (issue 1733). Read both sides as epoch ms
 * instead: strftime('%s') parses every text shape above (a zone-less one as
 * UTC, which is what CURRENT_TIMESTAMP means) and yields NULL for anything
 * else, which drops the row from the comparison rather than guessing.
 *
 * @param {object} query - Knex query builder
 * @param {string} column - Timestamp column name
 * @param {string} operator - One of '<', '<=', '>', '>='
 * @param {Date} date - Point in time to compare against
 * @returns {object} The query builder
 */
function whereTimestamp(query, column, operator, date) {
  if (!TIMESTAMP_OPERATORS.has(operator)) {
    throw new Error(`Unsupported timestamp comparison operator: ${operator}`);
  }
  if (isPostgreSQL()) {
    return query.where(column, operator, date);
  }
  const ms = sqliteTimestampMs(column);
  return query.whereRaw(`${ms.sql} ${operator} ?`, [...ms.bindings, date.getTime()]);
}

/**
 * SQLite only: the column read as epoch ms whatever shape it was stored in
 * (see whereTimestamp). For ORDER BY and CASE expressions that otherwise
 * compare the raw column, where numbers sort below every text.
 *
 * @param {string} column
 * @returns {{ sql: string, bindings: string[] }} fragment for a raw clause
 */
function sqliteTimestampMs(column) {
  // julianday() keeps the fractional second that strftime('%s') truncates,
  // so an ISO value with milliseconds compares like the epoch-ms rows and
  // like PostgreSQL. 2440587.5 is the Julian day of the Unix epoch.
  return {
    sql: '(CASE WHEN typeof(??) IN (\'integer\', \'real\') THEN ?? ELSE CAST(round((julianday(??) - 2440587.5) * 86400000) AS INTEGER) END)',
    bindings: [column, column, column],
  };
}

/**
 * Handle boolean values for database compatibility
 * @param {boolean} value - Boolean value
 * @returns {any} Database-appropriate boolean representation
 */
function formatBoolean(value) {
  if (isPostgreSQL()) {
    return value;
  } else {
    // SQLite stores booleans as 0/1
    return value ? 1 : 0;
  }
}

/**
 * Parse boolean from database
 * @param {any} value - Database boolean value
 * @returns {boolean} JavaScript boolean
 */
function parseBoolean(value) {
  return Boolean(value);
}

module.exports = {
  isPostgreSQL,
  whereTimestamp,
  sqliteTimestampMs,
  formatBoolean,
  parseBoolean
};