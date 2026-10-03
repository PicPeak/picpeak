const { toDateOnly } = require('../../src/utils/dateOnly');

describe('toDateOnly', () => {
  test('a pg Date at local midnight keeps its calendar day, east or west of UTC', () => {
    // The pg driver builds `new Date(y, m, d)` in the server's zone; the
    // local components are the day the row holds, whatever toISOString says.
    const local = new Date(2026, 9, 3);
    expect(toDateOnly(local)).toBe('2026-10-03');
    // One minute into the day still reads as that day, not as UTC's.
    expect(toDateOnly(new Date(2026, 0, 1, 0, 1))).toBe('2026-01-01');
  });

  test('SQLite text passes through, with any time component dropped', () => {
    expect(toDateOnly('2026-10-03')).toBe('2026-10-03');
    expect(toDateOnly('2026-10-03T00:00:00.000Z')).toBe('2026-10-03');
    expect(toDateOnly('2026-10-03 00:00:00')).toBe('2026-10-03');
  });

  test('no date stays no date', () => {
    expect(toDateOnly(null)).toBeNull();
    expect(toDateOnly(undefined)).toBeNull();
    expect(toDateOnly('')).toBeNull();
    expect(toDateOnly(new Date('nope'))).toBeNull();
  });
});
