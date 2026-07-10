/**
 * Shared Parser Utilities for Frontend
 * Pure functions for parsing and transforming input values
 *
 * @module utils/parsers
 */

/**
 * Parse any input value to boolean with configurable default
 * Handles: boolean, number, string representations
 *
 * @param value - Input value to parse
 * @param defaultValue - Default if value is undefined/null
 * @returns boolean result
 *
 * @example
 * toBoolean(true) // true
 * toBoolean('false') // false
 * toBoolean('1') // true
 * toBoolean(0) // false
 * toBoolean(undefined, false) // false
 */
export const toBoolean = (value: unknown, defaultValue = false): boolean => {
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
    const normalized = value.toLowerCase().trim();
    if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
    if (['false', '0', 'no', 'off', ''].includes(normalized)) return false;
  }
  return defaultValue;
};

/**
 * Parse numeric input with validation and optional bounds
 *
 * @param value - Input value to parse
 * @param defaultValue - Default if invalid
 * @param options - Bounds options
 * @returns number result
 *
 * @example
 * toNumber('42', 0) // 42
 * toNumber('abc', 10) // 10
 * toNumber(5, 0, { min: 10 }) // 10
 */
export const toNumber = (
  value: unknown,
  defaultValue: number,
  options?: { min?: number; max?: number }
): number => {
  if (value === undefined || value === null || value === '') {
    return defaultValue;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return defaultValue;
  }

  let result = parsed;
  if (options?.min !== undefined && result < options.min) result = options.min;
  if (options?.max !== undefined && result > options.max) result = options.max;

  return result;
};

/**
 * Parse string input with trimming and null handling
 *
 * @param value - Input value
 * @param defaultValue - Default if empty
 * @returns string or null
 *
 * @example
 * toString('  hello  ') // 'hello'
 * toString('') // null
 * toString(null, 'default') // 'default'
 */
export const toString = (value: unknown, defaultValue: string | null = null): string | null => {
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
 *
 * @param value - JSON string or already parsed value
 * @param defaultValue - Default if parsing fails
 * @returns parsed value or default
 */
export const parseJson = <T>(value: unknown, defaultValue: T): T => {
  if (value === undefined || value === null) {
    return defaultValue;
  }
  if (typeof value !== 'string') {
    return value as T;
  }
  try {
    return JSON.parse(value) as T;
  } catch {
    return defaultValue;
  }
};

/**
 * Parse date input to Date object
 *
 * @param value - Date string, Date object, or timestamp
 * @returns Date object or null if invalid
 */
export const toDate = (value: unknown): Date | null => {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  if (value instanceof Date) {
    return isNaN(value.getTime()) ? null : value;
  }
  const date = new Date(value as string | number);
  return isNaN(date.getTime()) ? null : date;
};

/**
 * Parse array input (handles JSON strings and arrays)
 *
 * @param value - Array or JSON string
 * @param defaultValue - Default if invalid
 * @returns array result
 */
export const toArray = <T>(value: unknown, defaultValue: T[] = []): T[] => {
  if (value === undefined || value === null) {
    return defaultValue;
  }
  if (Array.isArray(value)) {
    return value as T[];
  }
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : defaultValue;
    } catch {
      // Try comma-separated for string arrays
      return value.split(',').map(s => s.trim()).filter(Boolean) as T[];
    }
  }
  return defaultValue;
};

/**
 * Locale-tolerant decimal parser. Accepts strings using either '.' or
 * ',' as the decimal separator and either thousand-separator
 * convention (German "1.234,50" or English "1,234.50"). Crucially, this
 * is what we use to read CRM money/quantity fields whose <input> is
 * typed by humans in either an EN or DE locale — `Number('12,50')`
 * silently returns NaN, which the call-sites then coerce to 0, eating
 * real money.
 *
 * Heuristic when both separators appear: the LAST one is the decimal
 * separator; all earlier instances of either symbol are thousands and
 * are stripped. When only one separator appears, it's treated as the
 * decimal separator. Leading/trailing whitespace, currency glyphs
 * (€, $, CHF, etc.), and stray spaces inside the number are tolerated.
 *
 * Returns `NaN` when the input can't be coerced — callers should check
 * with `Number.isFinite` before persisting.
 *
 * Examples:
 *   parseLocaleDecimal('12,50')      // → 12.5   (DE)
 *   parseLocaleDecimal('12.50')      // → 12.5   (EN)
 *   parseLocaleDecimal('1.234,50')   // → 1234.5 (DE with thousands)
 *   parseLocaleDecimal('1,234.50')   // → 1234.5 (EN with thousands)
 *   parseLocaleDecimal('-7,5')       // → -7.5
 *   parseLocaleDecimal('€ 12,50')    // → 12.5
 *   parseLocaleDecimal('')           // → NaN
 *   parseLocaleDecimal('foo')        // → NaN
 */
export const parseLocaleDecimal = (value: unknown): number => {
  if (typeof value === 'number') return value;
  if (value === null || value === undefined) return NaN;
  let s = String(value).trim();
  if (!s) return NaN;
  // Strip whitespace + common currency symbols; leave digits, signs,
  // and the two separator characters.
  s = s.replace(/[\s€$£¥]/g, '').replace(/CHF/gi, '');
  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');
  if (lastDot === -1 && lastComma === -1) {
    // No separator — pure integer or noise.
    const n = Number(s);
    return Number.isFinite(n) ? n : NaN;
  }
  // The later separator wins as the decimal point; earlier separators
  // of either type are treated as thousands and stripped.
  const decimalAt = Math.max(lastDot, lastComma);
  const intPart = s.slice(0, decimalAt).replace(/[.,]/g, '');
  const fracPart = s.slice(decimalAt + 1);
  if (!fracPart && !intPart) return NaN;
  const normalised = `${intPart}.${fracPart}`;
  const n = Number(normalised);
  return Number.isFinite(n) ? n : NaN;
};

/**
 * Parse a duration shortcut into whole minutes.
 *
 * Accepts the three formats the maintainer types into the hours-log
 * form so they don't have to compute end-time mentally for a known
 * duration:
 *   - "1h", "2h", "0.5h", "1,5h" → hours, optional decimal
 *   - "1.5", "1,5", "0.75"       → bare decimal hours (DE comma OK)
 *   - "1:30", "0:45"             → H:MM
 *
 * Returns the duration in MINUTES (so call-sites adding to a start time
 * don't have to round). Returns `null` for empty, unparseable, or
 * negative input — the caller should ignore null instead of substituting
 * a default, so a typo doesn't silently overwrite an end-time the admin
 * already set.
 *
 * Examples:
 *   parseDuration('1h')    → 60
 *   parseDuration('1.5')   → 90
 *   parseDuration('1,5')   → 90
 *   parseDuration('1:30')  → 90
 *   parseDuration('0:45')  → 45
 *   parseDuration('')      → null
 *   parseDuration('1:99')  → null
 */
export const parseDuration = (value: unknown): number | null => {
  if (typeof value !== 'string') return null;
  const s = value.trim().toLowerCase();
  if (!s) return null;

  // H:MM form.
  const colonMatch = s.match(/^(\d+):([0-5]\d)$/);
  if (colonMatch) {
    const h = Number(colonMatch[1]);
    const m = Number(colonMatch[2]);
    if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
    const total = h * 60 + m;
    return total > 0 ? total : null;
  }

  // Strip a trailing 'h' (with optional whitespace).
  const stripped = s.replace(/\s*h$/, '');
  const hours = parseLocaleDecimal(stripped);
  if (!Number.isFinite(hours) || hours <= 0) return null;
  return Math.round(hours * 60);
};

// Re-export with alternative names for backwards compatibility
export const parseBooleanInput = toBoolean;
export const parseNumberInput = toNumber;
export const parseStringInput = toString;
