/**
 * Regression tests for clampIntOrUndefined — the slideshow-seed NaN bug.
 *
 * The event-create route seeds show_interval_ms/show_transition_ms from
 * app_settings via an int-parse-and-clamp. The old inline guard
 * (`Number.isFinite(+v) ? parseInt(v) : undefined`) disagreed with itself
 * for null/''/true: `+null` is 0 (finite) but `parseInt(null)` is NaN, so
 * NaN flowed through Math.min/Math.max into the INSERT. PostgreSQL
 * rejects NaN for integer columns ("invalid input syntax for type
 * integer: NaN") while SQLite silently stores NULL — so POST
 * /api/admin/events 500'd on PG whenever the slideshow settings rows
 * were absent (getAppSetting returns its null default).
 */

const { clampIntOrUndefined } = require('../../src/utils/numericHelpers');

describe('clampIntOrUndefined', () => {
  it('returns undefined for null (the getAppSetting missing-row default)', () => {
    expect(clampIntOrUndefined(null, 1000, 120000)).toBeUndefined();
  });

  it('returns undefined for undefined, empty string, and booleans', () => {
    expect(clampIntOrUndefined(undefined, 1000, 120000)).toBeUndefined();
    expect(clampIntOrUndefined('', 1000, 120000)).toBeUndefined();
    expect(clampIntOrUndefined(true, 1000, 120000)).toBeUndefined();
    expect(clampIntOrUndefined(false, 1000, 120000)).toBeUndefined();
  });

  it('returns undefined for non-numeric garbage', () => {
    expect(clampIntOrUndefined('fast', 1000, 120000)).toBeUndefined();
    expect(clampIntOrUndefined({}, 1000, 120000)).toBeUndefined();
  });

  it('never returns NaN for any of the failure-mode inputs', () => {
    for (const v of [null, undefined, '', true, false, 'x', {}, []]) {
      const out = clampIntOrUndefined(v, 100, 5000);
      expect(Number.isNaN(out)).toBe(false);
    }
  });

  it('parses and clamps valid values', () => {
    expect(clampIntOrUndefined('2500', 1000, 120000)).toBe(2500);
    expect(clampIntOrUndefined(2500, 1000, 120000)).toBe(2500);
    expect(clampIntOrUndefined('500', 1000, 120000)).toBe(1000);
    expect(clampIntOrUndefined(999999, 1000, 120000)).toBe(120000);
    expect(clampIntOrUndefined('2500.9', 1000, 120000)).toBe(2500);
  });
});
