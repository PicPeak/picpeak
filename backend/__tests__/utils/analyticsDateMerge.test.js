/**
 * Pins the date-merge fix in `adminDashboard.js` /analytics route
 * (#661 Bug A). The merge previously failed on Postgres because pg's
 * driver returns `DATE(timestamp)` as a JS Date object, while SQLite
 * returns a string — the old `dateObj.date === row.date` comparison
 * was false on Postgres so chartData stayed all-zero even with traffic.
 *
 * We test the normalisation helper here in isolation. The route-level
 * integration is covered by the existing dashboard route test.
 */

// The helper is internal to the route file; reimport via a small wrapper
// so we don't need to export everything publicly.
const path = require('path');
const fs = require('fs');

const ROUTE_SRC = fs.readFileSync(
  path.join(__dirname, '../../src/routes/adminDashboard.js'),
  'utf8',
);
// Tiny evaluator that grabs the normaliseDateKey function definition from
// the route source so the test pins the actual shipping implementation,
// not a copy.
function extractNormaliseDateKey() {
  const match = ROUTE_SRC.match(/function normaliseDateKey\([\s\S]*?\n\}/);
  if (!match) throw new Error('normaliseDateKey not found in adminDashboard.js');
  // eslint-disable-next-line no-new-func
  return new Function(`${match[0]}; return normaliseDateKey;`)();
}

const normaliseDateKey = extractNormaliseDateKey();

describe('analytics route — normaliseDateKey (#661 Bug A)', () => {
  test('passes through a YYYY-MM-DD string unchanged', () => {
    expect(normaliseDateKey('2026-06-22')).toBe('2026-06-22');
  });

  test('slices off a time component on a longer ISO string', () => {
    expect(normaliseDateKey('2026-06-22T00:00:00.000Z')).toBe('2026-06-22');
  });

  test('normalises a JS Date object (Postgres pg-driver shape) to YYYY-MM-DD', () => {
    const d = new Date('2026-06-22T12:34:56Z');
    expect(normaliseDateKey(d)).toBe('2026-06-22');
  });

  test('returns null for null / undefined / empty', () => {
    expect(normaliseDateKey(null)).toBeNull();
    expect(normaliseDateKey(undefined)).toBeNull();
    expect(normaliseDateKey('')).toBeNull();
  });

  test('coerces unexpected types via String() to avoid throwing', () => {
    // We don't expect to receive a number from either driver, but the
    // helper should not crash if it does — date merge will simply miss.
    expect(normaliseDateKey(20260622)).toBe('20260622');
  });
});
