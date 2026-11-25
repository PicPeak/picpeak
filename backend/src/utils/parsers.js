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
 * A row id from a URL segment or body: digits only, 1 to the int4 maximum
 * (photo ids are int4 on PostgreSQL, where a wider value is a 500, not a miss).
 * Returns the number, or null for anything else ("1e3", "1.5", "abc", "-1").
 */
const parsePositiveInt32 = (value) => {
  const text = typeof value === 'number' ? String(value) : value;
  if (typeof text !== 'string' || !/^[0-9]{1,10}$/.test(text)) return null;
  const n = Number(text);
  return n >= 1 && n <= 2147483647 ? n : null;
};

module.exports = {
  parsePositiveInt32,
  parseBooleanInput,
  parseStringInput
};
