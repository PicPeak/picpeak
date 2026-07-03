/**
 * Shared Parser Utilities
 * Pure functions for parsing and transforming input values
 *
 * @module utils/parsers
 */

/**
 * Parse any input value to boolean with configurable default
 * Handles: boolean, number, string representations
 *
 * @param {*} value - Input value to parse
 * @param {boolean} [defaultValue=true] - Default if value is undefined/null
 * @returns {boolean}
 *
 * @example
 * parseBooleanInput(true) // true
 * parseBooleanInput('false') // false
 * parseBooleanInput('1') // true
 * parseBooleanInput(0) // false
 * parseBooleanInput(undefined, false) // false
 */
const parseBooleanInput = (value, defaultValue = true) => {
  if (value === undefined || value === null) {
    return defaultValue;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return defaultValue;
    return value !== 0;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['false', '0', 'no', 'off', ''].includes(normalized)) {
      return false;
    }
    if (['true', '1', 'yes', 'on'].includes(normalized)) {
      return true;
    }
  }
  return defaultValue;
};

/**
 * Parse numeric input with validation and bounds
 *
 * @param {*} value - Input value to parse
 * @param {number} defaultValue - Default if invalid
 * @param {Object} [options] - Bounds options
 * @param {number} [options.min] - Minimum allowed value
 * @param {number} [options.max] - Maximum allowed value
 * @returns {number}
 *
 * @example
 * parseNumberInput('42', 0) // 42
 * parseNumberInput('abc', 10) // 10
 * parseNumberInput(5, 0, { min: 10 }) // 10
 * parseNumberInput(100, 0, { max: 50 }) // 50
 */
const parseNumberInput = (value, defaultValue, options = {}) => {
  const { min, max } = options;

  if (value === undefined || value === null || value === '') {
    return defaultValue;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return defaultValue;
  }

  let result = parsed;
  if (min !== undefined && result < min) result = min;
  if (max !== undefined && result > max) result = max;

  return result;
};

/**
 * Parse string input with trimming and null handling
 *
 * @param {*} value - Input value
 * @param {string|null} [defaultValue=null] - Default if empty
 * @returns {string|null}
 *
 * @example
 * parseStringInput('  hello  ') // 'hello'
 * parseStringInput('') // null
 * parseStringInput(null, 'default') // 'default'
 */
const parseStringInput = (value, defaultValue = null) => {
  if (value === undefined || value === null) {
    return defaultValue;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed || defaultValue;
  }
  return String(value);
};

/**
 * Parse JSON string safely
 * Returns the parsed value or default if parsing fails
 *
 * @param {*} value - JSON string or already parsed value
 * @param {*} [defaultValue=null] - Default if parsing fails
 * @returns {*}
 *
 * @example
 * parseJsonInput('{"a":1}') // { a: 1 }
 * parseJsonInput({ a: 1 }) // { a: 1 } (passthrough)
 * parseJsonInput('invalid', {}) // {}
 */
const parseJsonInput = (value, defaultValue = null) => {
  if (value === undefined || value === null) {
    return defaultValue;
  }
  if (typeof value !== 'string') {
    return value; // Already parsed
  }
  try {
    return JSON.parse(value);
  } catch {
    return defaultValue;
  }
};

/**
 * Parse email input with validation
 *
 * @param {*} value - Input value
 * @returns {string|null} - Valid email or null
 */
const parseEmailInput = (value) => {
  const str = parseStringInput(value);
  if (!str) return null;

  // Basic email validation
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(str) ? str.toLowerCase() : null;
};

/**
 * Parse date input to ISO string
 *
 * @param {*} value - Date string, Date object, or timestamp
 * @param {string|null} [defaultValue=null] - Default if invalid
 * @returns {string|null} - ISO date string (YYYY-MM-DD) or null
 */
const parseDateInput = (value, defaultValue = null) => {
  if (value === undefined || value === null || value === '') {
    return defaultValue;
  }

  const date = new Date(value);
  if (isNaN(date.getTime())) {
    return defaultValue;
  }

  // Return YYYY-MM-DD format
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

/**
 * Parse array input (handles JSON strings and arrays)
 *
 * @param {*} value - Array or JSON string
 * @param {Array} [defaultValue=[]] - Default if invalid
 * @returns {Array}
 */
const parseArrayInput = (value, defaultValue = []) => {
  if (value === undefined || value === null) {
    return defaultValue;
  }
  if (Array.isArray(value)) {
    return value;
  }
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : defaultValue;
    } catch {
      // Try comma-separated
      return value.split(',').map(s => s.trim()).filter(Boolean);
    }
  }
  return defaultValue;
};

module.exports = {
  parseBooleanInput,
  parseNumberInput,
  parseStringInput,
  parseJsonInput,
  parseEmailInput,
  parseDateInput,
  parseArrayInput
};
