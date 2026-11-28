const path = require('path');
const { execFileSync } = require('child_process');

// photos.captured_at is the camera's zone-less EXIF time read in the server's
// zone, so the admin list hands the browser that wall clock back, formatted
// in the server's zone (issue 1739). TZ does not re-bind in a running
// process, so a non-UTC server zone is forced in a child, as in
// dateNormalizeToTimestamp.test.js.
describe('toServerWallClock', () => {
  const helper = path.resolve(__dirname, '../../src/utils/dateNormalize');
  const run = (tz) => JSON.parse(execFileSync(process.execPath, ['-e', `
    const { toServerWallClock } = require(${JSON.stringify(helper)});
    // What exifr does with '2026:06:03 13:15:42': a Date at that local time.
    const exif = new Date(2026, 5, 3, 13, 15, 42);
    process.stdout.write(JSON.stringify({
      date: toServerWallClock(exif),
      epochMs: toServerWallClock(exif.getTime()),
      epochText: toServerWallClock(String(exif.getTime())),
      iso: toServerWallClock(exif.toISOString()),
      utcIso: toServerWallClock('2026-12-24T22:59:59.000Z'),
      nul: toServerWallClock(null),
      empty: toServerWallClock(''),
      bad: toServerWallClock('not a date'),
    }));
  `], { env: { ...process.env, TZ: tz }, encoding: 'utf8' }));

  it.each(['Europe/Berlin', 'America/Los_Angeles', 'UTC'])(
    'returns the camera clock for every stored shape in %s',
    (tz) => {
      const seen = run(tz);
      expect(seen.date).toBe('2026-06-03T13:15:42');
      expect(seen.epochMs).toBe('2026-06-03T13:15:42');
      expect(seen.epochText).toBe('2026-06-03T13:15:42');
      expect(seen.iso).toBe('2026-06-03T13:15:42');
      expect(seen.nul).toBeNull();
      expect(seen.empty).toBeNull();
      expect(seen.bad).toBeNull();
    },
  );

  it('formats an instant in the server zone, not UTC', () => {
    expect(run('Europe/Berlin').utcIso).toBe('2026-12-24T23:59:59');
    expect(run('UTC').utcIso).toBe('2026-12-24T22:59:59');
  });
});

// One rule for "the capture time to show" (issue 2617): the admin list, the
// chapter times and the zip entry dates all read it through photoWallClock.
describe('photoWallClock', () => {
  const { photoWallClock, toServerWallClock } = require('../../src/utils/dateNormalize');
  const instant = '2024-12-24T17:00:10.000Z';

  it('is the camera clock as written, its offset dropped', () => {
    expect(photoWallClock({ captured_at_wall: '2025-06-01T09:45:03+02:00', captured_at: instant })).toBe('2025-06-01T09:45:03');
  });

  it('is the stored instant in the server zone where no camera clock was read', () => {
    expect(photoWallClock({ captured_at_wall: null, captured_at: instant })).toBe(toServerWallClock(instant));
    expect(photoWallClock({ captured_at_wall: '', captured_at: instant })).toBe(toServerWallClock(instant));
    expect(photoWallClock({ captured_at_wall: null, captured_at: null })).toBeNull();
  });

  it.each([
    '2025-00-01T09:45:03', '2025-13-01T09:45:03', '2025-02-30T09:45:03', '2025-06-31T09:45:03',
    '2025-06-01T24:00:00', '2025-06-01T09:60:00',
  ])('takes digits that are no date-time (%s) for no camera clock', (wall) => {
    expect(photoWallClock({ captured_at_wall: wall, captured_at: instant })).toBe(toServerWallClock(instant));
    expect(photoWallClock({ captured_at_wall: wall, captured_at: null })).toBeNull();
  });
});
