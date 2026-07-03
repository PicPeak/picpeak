/**
 * Unit tests for the per-weekday business-hours floor (migration 114).
 * Exercises the pure snap logic against a fixed IANA zone so the results
 * don't drift with the CI box's local timezone.
 *
 * All scenarios use Europe/Zurich (the regulatory-scope default).
 */

const {
  snapToBusinessHours,
  parseHHMM,
  minutesToHHMM,
  normaliseSchedule,
  hasAnyBlocks,
  _internal,
} = require('../../src/utils/businessHours');

const TZ = 'Europe/Zurich';

// Mon–Fri 09:00–18:00, weekend closed. Plain string-block storage shape.
const STANDARD = {
  '1': [{ start: '09:00', end: '18:00' }],
  '2': [{ start: '09:00', end: '18:00' }],
  '3': [{ start: '09:00', end: '18:00' }],
  '4': [{ start: '09:00', end: '18:00' }],
  '5': [{ start: '09:00', end: '18:00' }],
  '6': [],
  '7': [],
};

// Mon–Fri with a lunch break (09:00–12:00, 13:00–18:00).
const LUNCH = {
  '1': [{ start: '09:00', end: '12:00' }, { start: '13:00', end: '18:00' }],
  '2': [{ start: '09:00', end: '12:00' }, { start: '13:00', end: '18:00' }],
  '3': [{ start: '09:00', end: '12:00' }, { start: '13:00', end: '18:00' }],
  '4': [{ start: '09:00', end: '12:00' }, { start: '13:00', end: '18:00' }],
  '5': [{ start: '09:00', end: '12:00' }, { start: '13:00', end: '18:00' }],
  '6': [],
  '7': [],
};

const cfg = (schedule, overrides = {}) => ({
  enabled: true,
  timezone: TZ,
  schedule,
  ...overrides,
});

// Build a UTC instant from a Zurich wall-clock so the assertions read in
// local terms. Reuses the module's own converter (covered separately).
function zurich(y, mo, d, hh, mi) {
  return _internal.zonedWallClockToUtc(y, mo, d, hh, mi, TZ);
}

function partsOf(date) {
  const p = _internal.getZonedParts(date, TZ);
  return [p.y, p.mo, p.d, p.hh, p.mi];
}

describe('parseHHMM / minutesToHHMM', () => {
  it('parses valid times to minutes', () => {
    expect(parseHHMM('09:00')).toBe(540);
    expect(parseHHMM('00:00')).toBe(0);
    expect(parseHHMM('23:59')).toBe(1439);
  });
  it('rejects malformed input', () => {
    expect(parseHHMM('9:00')).toBeNull();
    expect(parseHHMM('24:00')).toBeNull();
    expect(parseHHMM('12:60')).toBeNull();
    expect(parseHHMM('')).toBeNull();
    expect(parseHHMM(null)).toBeNull();
  });
  it('round-trips minutesToHHMM', () => {
    expect(minutesToHHMM(540)).toBe('09:00');
    expect(minutesToHHMM(0)).toBe('00:00');
    expect(minutesToHHMM(1439)).toBe('23:59');
  });
});

describe('normaliseSchedule', () => {
  it('parses, sorts, and drops invalid blocks', () => {
    const out = normaliseSchedule({
      '1': [{ start: '13:00', end: '18:00' }, { start: '09:00', end: '12:00' }],
      '2': [{ start: '18:00', end: '09:00' }], // end<=start → dropped
      '3': [{ start: 'bad', end: '18:00' }],   // malformed → dropped
    });
    expect(out['1']).toEqual([
      { start: '09:00', end: '12:00' },
      { start: '13:00', end: '18:00' },
    ]);
    expect(out['2']).toEqual([]);
    expect(out['3']).toEqual([]);
    expect(out['7']).toEqual([]);
  });
  it('accepts [start,end] pair blocks and a JSON string', () => {
    const out = normaliseSchedule(JSON.stringify({ '4': [['09:00', '17:00']] }));
    expect(out['4']).toEqual([{ start: '09:00', end: '17:00' }]);
  });
  it('garbage input → all-empty week', () => {
    expect(hasAnyBlocks(normaliseSchedule('not json'))).toBe(false);
    expect(hasAnyBlocks(normaliseSchedule(null))).toBe(false);
  });
});

describe('snapToBusinessHours — single window (Mon–Fri 09:00–18:00)', () => {
  it('weekday before open (Tue 02:11) → SAME day 09:00', () => {
    // 2026-06-02 is a Tuesday.
    const out = snapToBusinessHours(zurich(2026, 6, 2, 2, 11), cfg(STANDARD));
    expect(partsOf(out)).toEqual([2026, 6, 2, 9, 0]);
  });

  it('weekday inside window (Tue 10:30) → unchanged', () => {
    const input = zurich(2026, 6, 2, 10, 30);
    expect(snapToBusinessHours(input, cfg(STANDARD)).getTime()).toBe(input.getTime());
  });

  it('weekday after close (Tue 20:00) → next business day 09:00 (Wed)', () => {
    const out = snapToBusinessHours(zurich(2026, 6, 2, 20, 0), cfg(STANDARD));
    expect(partsOf(out)).toEqual([2026, 6, 3, 9, 0]);
  });

  it('Sunday 14:00 → Monday 09:00', () => {
    // 2026-06-07 is a Sunday; 2026-06-08 is the Monday.
    const out = snapToBusinessHours(zurich(2026, 6, 7, 14, 0), cfg(STANDARD));
    expect(partsOf(out)).toEqual([2026, 6, 8, 9, 0]);
  });

  it('Saturday before open (Sat 02:11) → Monday 09:00 (closed day, not same-day)', () => {
    const out = snapToBusinessHours(zurich(2026, 6, 6, 2, 11), cfg(STANDARD));
    expect(partsOf(out)).toEqual([2026, 6, 8, 9, 0]);
  });

  it('Friday after close (Fri 19:30) → Monday 09:00 (skips weekend)', () => {
    // 2026-06-05 is a Friday.
    const out = snapToBusinessHours(zurich(2026, 6, 5, 19, 30), cfg(STANDARD));
    expect(partsOf(out)).toEqual([2026, 6, 8, 9, 0]);
  });

  it('exactly at open (Tue 09:00) → unchanged (inclusive lower bound)', () => {
    const input = zurich(2026, 6, 2, 9, 0);
    expect(snapToBusinessHours(input, cfg(STANDARD)).getTime()).toBe(input.getTime());
  });

  it('exactly at close (Tue 18:00) → next business day 09:00 (exclusive upper bound)', () => {
    const out = snapToBusinessHours(zurich(2026, 6, 2, 18, 0), cfg(STANDARD));
    expect(partsOf(out)).toEqual([2026, 6, 3, 9, 0]);
  });
});

describe('snapToBusinessHours — lunch break (09:00–12:00, 13:00–18:00)', () => {
  it('morning block (Tue 10:30) → unchanged', () => {
    const input = zurich(2026, 6, 2, 10, 30);
    expect(snapToBusinessHours(input, cfg(LUNCH)).getTime()).toBe(input.getTime());
  });

  it('during lunch (Tue 12:30) → SAME day 13:00 (next block open)', () => {
    const out = snapToBusinessHours(zurich(2026, 6, 2, 12, 30), cfg(LUNCH));
    expect(partsOf(out)).toEqual([2026, 6, 2, 13, 0]);
  });

  it('exactly at lunch start (Tue 12:00) → 13:00 (block end is exclusive)', () => {
    const out = snapToBusinessHours(zurich(2026, 6, 2, 12, 0), cfg(LUNCH));
    expect(partsOf(out)).toEqual([2026, 6, 2, 13, 0]);
  });

  it('afternoon block (Tue 17:59) → unchanged', () => {
    const input = zurich(2026, 6, 2, 17, 59);
    expect(snapToBusinessHours(input, cfg(LUNCH)).getTime()).toBe(input.getTime());
  });

  it('before open (Tue 07:00) → SAME day 09:00 (first block)', () => {
    const out = snapToBusinessHours(zurich(2026, 6, 2, 7, 0), cfg(LUNCH));
    expect(partsOf(out)).toEqual([2026, 6, 2, 9, 0]);
  });

  it('after close (Tue 19:00) → next day 09:00', () => {
    const out = snapToBusinessHours(zurich(2026, 6, 2, 19, 0), cfg(LUNCH));
    expect(partsOf(out)).toEqual([2026, 6, 3, 9, 0]);
  });
});

describe('snapToBusinessHours — per-day differing hours', () => {
  const PERDAY = {
    '1': [{ start: '08:00', end: '12:00' }],          // Mon morning only
    '2': [],                                          // Tue closed
    '3': [{ start: '14:00', end: '20:00' }],          // Wed afternoon/evening
    '4': [], '5': [], '6': [], '7': [],
  };

  it('Mon after its noon close (Mon 13:00) → skips closed Tue → Wed 14:00', () => {
    // 2026-06-01 is a Monday; 2026-06-03 is the Wednesday.
    const out = snapToBusinessHours(zurich(2026, 6, 1, 13, 0), cfg(PERDAY));
    expect(partsOf(out)).toEqual([2026, 6, 3, 14, 0]);
  });

  it('closed Tuesday (Tue 10:00) → Wed 14:00', () => {
    const out = snapToBusinessHours(zurich(2026, 6, 2, 10, 0), cfg(PERDAY));
    expect(partsOf(out)).toEqual([2026, 6, 3, 14, 0]);
  });

  it('Wed before its 14:00 open (Wed 09:00) → SAME day 14:00', () => {
    const out = snapToBusinessHours(zurich(2026, 6, 3, 9, 0), cfg(PERDAY));
    expect(partsOf(out)).toEqual([2026, 6, 3, 14, 0]);
  });
});

describe('snapToBusinessHours — passthrough cases', () => {
  it('floor disabled → unchanged even when outside hours', () => {
    const input = zurich(2026, 6, 2, 2, 11);
    expect(snapToBusinessHours(input, cfg(STANDARD, { enabled: false })).getTime())
      .toBe(input.getTime());
  });

  it('empty schedule → unchanged (nothing to snap to)', () => {
    const empty = normaliseSchedule(null);
    const input = zurich(2026, 6, 7, 14, 0);
    expect(snapToBusinessHours(input, cfg(empty)).getTime()).toBe(input.getTime());
  });

  it('non-Date / invalid input is passed through untouched', () => {
    expect(snapToBusinessHours(null, cfg(STANDARD))).toBeNull();
    const bad = new Date('not-a-date');
    expect(Number.isNaN(snapToBusinessHours(bad, cfg(STANDARD)).getTime())).toBe(true);
  });
});

describe('_internal round-trips', () => {
  it('zonedWallClockToUtc → getZonedParts reconstructs the wall-clock', () => {
    const d = _internal.zonedWallClockToUtc(2026, 6, 2, 9, 0, TZ);
    const p = _internal.getZonedParts(d, TZ);
    expect([p.y, p.mo, p.d, p.hh, p.mi]).toEqual([2026, 6, 2, 9, 0]);
  });

  it('isoWeekday: 2026-06-07 is Sunday (7), 2026-06-08 is Monday (1)', () => {
    expect(_internal.isoWeekday(2026, 6, 7)).toBe(7);
    expect(_internal.isoWeekday(2026, 6, 8)).toBe(1);
  });
});
