const { toUtcIso } = require('../../src/utils/queueTimestamps');

describe('toUtcIso', () => {
  test('a zone-less SQLite default is UTC, not local time', () => {
    expect(toUtcIso('2026-10-05 14:00:00')).toBe('2026-10-05T14:00:00.000Z');
    expect(toUtcIso('2026-10-05T14:00:00.250')).toBe('2026-10-05T14:00:00.250Z');
  });

  test('Dates, epoch ms and zoned strings keep their instant', () => {
    const at = Date.UTC(2026, 9, 5, 14, 0, 0);
    expect(toUtcIso(new Date(at))).toBe('2026-10-05T14:00:00.000Z');
    expect(toUtcIso(at)).toBe('2026-10-05T14:00:00.000Z');
    expect(toUtcIso(String(at))).toBe('2026-10-05T14:00:00.000Z');
    expect(toUtcIso('2026-10-05T16:00:00+02:00')).toBe('2026-10-05T14:00:00.000Z');
  });

  test('nothing readable is null', () => {
    expect(toUtcIso(null)).toBeNull();
    expect(toUtcIso(undefined)).toBeNull();
    expect(toUtcIso('')).toBeNull();
    expect(toUtcIso('[object Object]')).toBeNull();
  });
});
