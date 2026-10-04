/**
 * Database Compatibility Utilities
 * Handles differences between PostgreSQL and SQLite
 */

// Note: Requiring db here creates circular dependency
// db should be passed as parameter or required where needed
const logger = require('./logger');

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

/**
 * Handle insert operations that return IDs
 * Works with both PostgreSQL and SQLite
 * @param {object} query - Knex query builder
 * @returns {Promise<number>} The inserted ID
 */
async function insertAndGetId(query) {
  const result = await query.returning('id');
  
  // PostgreSQL returns array of objects [{id: 1}]
  // SQLite returns array of IDs [1]
  return result[0]?.id || result[0];
}

/**
 * Format date for database compatibility
 * @param {Date} date - JavaScript Date object
 * @returns {string} ISO string format that works on both databases
 */
function formatDateForDB(date) {
  return date.toISOString();
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
 * Add days to a date (database agnostic)
 * @param {Date} date - Starting date
 * @param {number} days - Number of days to add
 * @returns {Date} New date
 */
function addDays(date, days) {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

/**
 * Get date extraction SQL that works on both databases
 * @param {object} db - Knex database instance
 * @param {string} column - Column name
 * @returns {object} Knex raw query
 */
function dateExtractSQL(db, column) {
  if (isPostgreSQL()) {
    return db.raw(`DATE(${column})`);
  } else {
    // SQLite uses date() function
    return db.raw(`date(${column})`);
  }
}

/**
 * Get database size query
 * @param {object} db - Knex database instance
 * @param {string} dbName - Database name
 * @returns {Promise<number>} Size in bytes
 */
async function getDatabaseSize(db, dbName) {
  if (isPostgreSQL()) {
    const result = await db.raw('SELECT pg_database_size(?) as size', [dbName]);
    return result.rows[0]?.size || 0;
  } else {
    // For SQLite, check file size
    const fs = require('fs').promises;
    const path = require('path');
    const dbPath = process.env.DATABASE_PATH || path.join(__dirname, '../../data/photo_sharing.db');
    try {
      const stats = await fs.stat(dbPath);
      return stats.size;
    } catch (error) {
      logger.error('Error getting SQLite database size:', error);
      return 0;
    }
  }
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
  getDbClient,
  isPostgreSQL,
  insertAndGetId,
  formatDateForDB,
  whereTimestamp,
  sqliteTimestampMs,
  addDays,
  dateExtractSQL,
  getDatabaseSize,
  formatBoolean,
  parseBoolean
};