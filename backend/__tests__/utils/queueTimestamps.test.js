/**
 * email_queue timestamps come back in three shapes and must all read as the
 * same instant (#1262).
 *
 * The naive-string case is the one that bites in production and cannot be
 * pinned from inside this suite: CI runs in UTC, where reading a zone-less
 * timestamp as local time and as UTC give the same answer. So those two cases
 * run in child processes with TZ forced, which is the only way to make the
 * assertion fail on a machine where the bug does not reproduce.
 */
const { execFileSync } = require('child_process');
const path = require('path');

const { toMillis } = require('../../src/utils/queueTimestamps');

const UTIL = path.resolve(__dirname, '../../src/utils/queueTimestamps.js');

/** Parse `value` in a fresh node process pinned to `tz`. */
function parseUnderTz(tz, value) {
  const script = `
    const { toMillis } = require(${JSON.stringify(UTIL)});
    process.stdout.write(String(toMillis(${JSON.stringify(value)})));
  `;
  return Number(execFileSync(process.execPath, ['-e', script], {
    env: { ...process.env, TZ: tz },
    encoding: 'utf8',
  }));
}

describe('toMillis — the shapes email_queue timestamps really have', () => {
  const INSTANT = Date.UTC(2026, 8, 2, 12, 0, 0);

  it('reads a Date, as Postgres returns', () => {
    expect(toMillis(new Date(INSTANT))).toBe(INSTANT);
  });

  it('reads epoch ms, as SQLite stores what queueEmail writes', () => {
    expect(toMillis(INSTANT)).toBe(INSTANT);
    expect(toMillis(String(INSTANT))).toBe(INSTANT);
  });

  it('reads an ISO string, as fixtures and older rows carry', () => {
    expect(toMillis('2026-09-02T12:00:00.000Z')).toBe(INSTANT);
  });

  it('cannot read nulls or nonsense, and says so rather than guessing', () => {
    // The caller skips a row it cannot judge; returning 0 or NaN here would
    // report every such row as decades overdue.
    expect(toMillis(null)).toBeNull();
    expect(toMillis(undefined)).toBeNull();
    expect(toMillis('')).toBeNull();
    expect(toMillis('   ')).toBeNull();
    expect(toMillis('not a timestamp')).toBeNull();
  });

  describe('CURRENT_TIMESTAMP on SQLite, which carries no zone', () => {
    // Both columns default to CURRENT_TIMESTAMP. SQLite renders that as
    // 'YYYY-MM-DD HH:MM:SS' in UTC with no marker, and Date.parse reads that
    // shape as LOCAL time.
    const NAIVE = '2026-09-02 12:00:00';

    it('is UTC west of Greenwich, where the old reading looked into the future', () => {
      // Read as local in New York, this instant lands 4h later than it is, so
      // a row due now looked 4h away and never reached the waiting list.
      expect(parseUnderTz('America/New_York', NAIVE)).toBe(INSTANT);
    });

    it('is UTC east of it, where the old reading looked into the past', () => {
      // Nine hours the other way: fresh mail read as long overdue, which fills
      // the page with rows that are perfectly fine.
      expect(parseUnderTz('Asia/Tokyo', NAIVE)).toBe(INSTANT);
    });

    it('agrees with itself across zones', () => {
      expect(parseUnderTz('America/New_York', NAIVE))
        .toBe(parseUnderTz('Asia/Tokyo', NAIVE));
    });

    it('accepts the fractional-seconds variant too', () => {
      expect(parseUnderTz('America/New_York', '2026-09-02 12:00:00.000')).toBe(INSTANT);
    });
  });
});
