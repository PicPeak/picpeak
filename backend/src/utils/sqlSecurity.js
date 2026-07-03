/**
 * SQL Security Utilities
 * Provides safe methods for handling user input in SQL queries
 */

/**
 * Validate and sanitize days parameter for date range queries
 * @param {any} days - The days parameter from user input
 * @returns {number} Safe integer between 1 and 365
 */
function sanitizeDays(days) {
  const parsed = parseInt(days);
  
  // Check if it's a valid number
  if (isNaN(parsed)) {
    return 7; // Default to 7 days
  }
  
  // Ensure it's within reasonable bounds
  if (parsed < 1) {
    return 1;
  }
  
  if (parsed > 365) {
    return 365; // Maximum 1 year
  }
  
  return parsed;
}

/**
 * Escape special characters in LIKE queries
 * @param {string} input - The search string from user input
 * @returns {string} Escaped string safe for LIKE queries
 */
function escapeLikePattern(input) {
  if (!input || typeof input !== 'string') {
    return '';
  }
  
  // Escape special LIKE pattern characters
  // In SQL LIKE patterns:
  // % matches any sequence of characters
  // _ matches any single character
  // \ is the escape character
  return input
    .replace(/\\/g, '\\\\') // Escape backslashes first
    .replace(/%/g, '\\%')   // Escape percent signs
    .replace(/_/g, '\\_')   // Escape underscores
    .replace(/'/g, '\'\'');   // Escape single quotes for safety
}

/**
 * Create a safe date range condition using Knex
 * @param {object} query - Knex query builder instance
 * @param {string} column - The timestamp column name
 * @param {number} days - Number of days to go back
 * @returns {object} Modified query with safe date range condition
 */
function addDateRangeCondition(query, column, days) {
  const safeDays = sanitizeDays(days);
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - safeDays);
  
  // Use Knex's built-in date comparison which handles parameterization
  return query.where(column, '>=', startDate.toISOString());
}

/**
 * Create a safe LIKE condition using Knex
 * @param {object} query - Knex query builder instance
 * @param {string} column - The column to search
 * @param {string} pattern - The search pattern
 * @returns {object} Modified query with safe LIKE condition
 */
function addLikeCondition(query, column, pattern) {
  if (!pattern || typeof pattern !== 'string') {
    return query;
  }
  
  const escapedPattern = escapeLikePattern(pattern);
  // Knex handles parameterization of the LIKE value
  return query.where(column, 'like', `%${escapedPattern}%`);
}

/**
 * Validate sort column against whitelist
 * @param {string} column - The column name to sort by
 * @param {string[]} allowedColumns - Array of allowed column names
 * @param {string} defaultColumn - Default column if invalid
 * @returns {string} Safe column name
 */
function validateSortColumn(column, allowedColumns, defaultColumn) {
  if (!column || !allowedColumns.includes(column)) {
    return defaultColumn;
  }
  return column;
}

/**
 * Validate sort order
 * @param {string} order - The sort order (asc/desc)
 * @returns {string} Safe sort order
 */
function validateSortOrder(order) {
  const lowerOrder = (order || '').toLowerCase();
  return lowerOrder === 'asc' ? 'asc' : 'desc';
}

module.exports = {
  sanitizeDays,
  escapeLikePattern,
  addDateRangeCondition,
  addLikeCondition,
  validateSortColumn,
  validateSortOrder
};