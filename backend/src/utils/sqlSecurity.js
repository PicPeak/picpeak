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
 * Escape the LIKE metacharacters in a search term so it matches itself.
 *
 * The result is a BOUND value — it goes into the `?` of a prepared statement,
 * never into SQL text. That is why single quotes are left alone: doubling them
 * is SQL string-literal syntax, and inside a bound value it is not escaping
 * anything, it is corrupting the search term (a search for "Sarah's Birthday"
 * would be sent as "Sarah''s Birthday" and match nothing).
 *
 * Only the three characters LIKE itself reads are escaped:
 *   %  matches any sequence of characters
 *   _  matches any single character
 *   \  the escape character named by the ESCAPE clause
 *
 * Pair the result with likeWithEscape() — without an explicit ESCAPE clause
 * the backslashes below mean different things on Postgres and SQLite.
 *
 * @param {string} input - The search string from user input
 * @returns {string} Escaped string safe to bind into a LIKE pattern
 */
function escapeLikePattern(input) {
  if (!input || typeof input !== 'string') {
    return '';
  }

  return input.replace(/[\\%_]/g, '\\$&');
}

/**
 * Build a `LIKE ? ESCAPE '\'` comparison for a column.
 *
 * The ESCAPE clause is load-bearing rather than decorative: Postgres treats a
 * backslash in a LIKE pattern as an escape character by default, SQLite has no
 * default escape character at all and would match the backslash literally. Naming
 * it makes escapeLikePattern()'s output mean the same thing on both engines.
 *
 * `column` is interpolated into the SQL text, so callers must pass a literal
 * column name — never user input. The search term stays bound.
 *
 * @param {string} column - Literal column name (optionally table-qualified)
 * @returns {string} Raw SQL fragment with a single `?` binding placeholder
 */
function likeWithEscape(column) {
  return `${column} LIKE ? ESCAPE '\\'`;
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
  
  // Knex handles parameterization of the LIKE value
  return query.whereRaw(likeWithEscape(column), [`%${escapeLikePattern(pattern)}%`]);
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
  likeWithEscape,
  addDateRangeCondition,
  addLikeCondition,
  validateSortColumn,
  validateSortOrder
};