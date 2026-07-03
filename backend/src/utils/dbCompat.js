/**
 * Database Compatibility Utilities
 * Handles differences between PostgreSQL and SQLite
 */

// Note: Requiring db here creates circular dependency
// db should be passed as parameter or required where needed

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
      console.error('Error getting SQLite database size:', error);
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
  addDays,
  dateExtractSQL,
  getDatabaseSize,
  formatBoolean,
  parseBoolean
};