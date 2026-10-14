/**
 * A gallery expiry picked as a calendar day is open through the end of that
 * day in the instance time zone (follow-up to issue 1975). The helpers take
 * the zone as an argument, so every zone is pinned in-test; the process-zone
 * fallback runs in a child process with TZ set, since TZ does not re-bind
 * inside a running process.
 */
const path = require('path');
const { execFileSync } = require('child_process');

const mockProfile = { row: null, error: null };
jest.mock('../../src/database/db', () => ({
  db: () => ({
    where: () => ({
      first: async () => {
        if (mockProfile.error) throw mockProfile.error;
        return mockProfile.row;
      },
    }),
  }),
}));

const {
  getInstanceTimeZone, endOfDayInZone, addDaysToDate, dateInZone,
  expiryCalendarDate, parseExpiryInput, extendExpiry,
} = require('../../src/utils/galleryExpiry');

const iso = (date) => date.toISOString();

describe('endOfDayInZone', () => {
  test.each([
    ['UTC', '2026-12-24T23:59:59.999Z'],
    ['Europe/Berlin', '2026-12-24T22:59:59.999Z'],
    ['America/New_York', '2026-12-25T04:59:59.999Z'],
    ['Pacific/Kiritimati', '2026-12-24T09:59:59.999Z'],
    ['Asia/Kolkata', '2026-12-24T18:29:59.999Z'],
  ])('24 Dec 2026 in %s ends at %s', (tz, expected) => {
    expect(iso(endOfDayInZone('2026-12-24', tz))).toBe(expected);
  });

  test('the day the clocks change keeps its own end of day', () => {
    // Berlin: CET → CEST on 29 Mar, back on 25 Oct 2026.
    expect(iso(endOfDayInZone('2026-03-29', 'Europe/Berlin'))).toBe('2026-03-29T21:59:59.999Z');
    expect(iso(endOfDayInZone('2026-10-25', 'Europe/Berlin'))).toBe('2026-10-25T22:59:59.999Z');
    // Santiago skips from 24:00 to 01:00 on 5 Sep 2026: the next day's
    // midnight does not exist, 23:59:59.999 of the 5th does (UTC-4).
    expect(iso(endOfDayInZone('2026-09-05', 'America/Santiago'))).toBe('2026-09-06T03:59:59.999Z');
    // Santiago goes back from 24:00 to 23:00 on 4 Apr 2026: 23:59 happens
    // twice, and the day ends at the later one (UTC-4), not an hour early.
    expect(iso(endOfDayInZone('2026-04-04', 'America/Santiago'))).toBe('2026-04-05T03:59:59.999Z');
  });

  test('is the last millisecond of that day in the zone', () => {
    for (const tz of ['America/New_York', 'Europe/Berlin', 'Pacific/Kiritimati', 'America/Santiago', 'America/Nuuk']) {
      for (const day of ['2026-03-08', '2026-03-28', '2026-03-29', '2026-04-04', '2026-09-05', '2026-10-24', '2026-11-01', '2026-12-24']) {
        const end = endOfDayInZone(day, tz);
        expect(dateInZone(end, tz)).toBe(day);
        expect(dateInZone(new Date(end.getTime() + 1), tz)).toBe(addDaysToDate(day, 1));
      }
    }
  });

  test('anything but a real yyyy-MM-dd is null', () => {
    expect(endOfDayInZone('2026-02-30', 'UTC')).toBeNull();
    expect(endOfDayInZone('2026-12-24T10:00:00Z', 'UTC')).toBeNull();
    expect(endOfDayInZone('soon', 'UTC')).toBeNull();
  });
});

describe('addDaysToDate', () => {
  test('crosses month and year ends', () => {
    expect(addDaysToDate('2026-12-24', 30)).toBe('2027-01-23');
    expect(addDaysToDate('2028-02-28', 1)).toBe('2028-02-29');
  });
});

describe('expiryCalendarDate reads every stored shape back as the picked day', () => {
  test('a new end-of-day row is its own day in the instance zone', () => {
    for (const tz of ['America/New_York', 'Europe/Berlin', 'Pacific/Kiritimati']) {
      expect(expiryCalendarDate(endOfDayInZone('2026-12-24', tz).toISOString(), tz)).toBe('2026-12-24');
    }
  });

  test('an old settings-form row (midnight UTC) is its UTC date, also west of UTC', () => {
    expect(expiryCalendarDate('2026-12-24T00:00:00.000Z', 'America/New_York')).toBe('2026-12-24');
    expect(expiryCalendarDate('2026-12-24T00:00:00.000Z', 'Pacific/Kiritimati')).toBe('2026-12-24');
  });

  test('an old creation row (the server\'s local midnight) is its day when the server ran in that zone', () => {
    expect(expiryCalendarDate('2026-12-24T05:00:00.000Z', 'America/New_York')).toBe('2026-12-24');
    expect(expiryCalendarDate('2026-12-23T23:00:00.000Z', 'Europe/Berlin')).toBe('2026-12-24');
  });

  test('takes a Date and SQLite epoch ms, and is null for garbage', () => {
    const end = endOfDayInZone('2026-12-24', 'America/New_York');
    expect(expiryCalendarDate(end, 'America/New_York')).toBe('2026-12-24');
    expect(expiryCalendarDate(end.getTime(), 'America/New_York')).toBe('2026-12-24');
    expect(expiryCalendarDate(String(end.getTime()), 'America/New_York')).toBe('2026-12-24');
    expect(expiryCalendarDate('not a date', 'UTC')).toBeNull();
  });
});

describe('parseExpiryInput', () => {
  test('a bare date is the end of that day in the zone', () => {
    expect(iso(parseExpiryInput('2026-12-24', 'America/New_York'))).toBe('2026-12-25T04:59:59.999Z');
    expect(iso(parseExpiryInput(' 2026-12-24 ', 'Europe/Berlin'))).toBe('2026-12-24T22:59:59.999Z');
    expect(parseExpiryInput('2026-02-30', 'UTC')).toBeNull();
  });

  test('a date-time keeps its instant (parseExpiresAtText)', () => {
    expect(iso(parseExpiryInput('2026-12-24T10:00:00+02:00', 'America/New_York'))).toBe('2026-12-24T08:00:00.000Z');
    expect(iso(parseExpiryInput('2026-12-24T10:00:00', 'America/New_York'))).toBe('2026-12-24T10:00:00.000Z');
    expect(parseExpiryInput(42, 'UTC')).toBeNull();
  });
});

describe('extendExpiry', () => {
  test('an end-of-day expiry stays end-of-day across a DST change in the zone', () => {
    const from = endOfDayInZone('2026-03-20', 'Europe/Berlin'); // CET
    expect(iso(extendExpiry(from, 14, 'Europe/Berlin'))).toBe(iso(endOfDayInZone('2026-04-03', 'Europe/Berlin')));
    const ny = endOfDayInZone('2026-10-28', 'America/New_York'); // EDT → EST on 1 Nov
    expect(iso(extendExpiry(ny, 7, 'America/New_York'))).toBe(iso(endOfDayInZone('2026-11-04', 'America/New_York')));
  });

  test('extending onto a day whose last hour repeats ends at its later 23:59', () => {
    const from = endOfDayInZone('2026-04-03', 'America/Santiago');
    expect(iso(extendExpiry(from, 1, 'America/Santiago'))).toBe('2026-04-05T03:59:59.999Z');
  });

  test('extending from a day whose last hour is skipped stays end-of-day', () => {
    // Nuuk jumps from 23:00 to 24:00 on 28 Mar 2026: that day ends at 22:59:59.999 local.
    const from = endOfDayInZone('2026-03-28', 'America/Nuuk');
    expect(iso(extendExpiry(from, 1, 'America/Nuuk'))).toBe(iso(endOfDayInZone('2026-03-29', 'America/Nuuk')));
    expect(iso(extendExpiry(from, 1, 'America/Nuuk'))).toBe('2026-03-30T00:59:59.999Z');
  });

  test('a plain 24 h step would have landed on the wrong day', () => {
    // The reason extend counts calendar days in the zone, not 86 400 000 ms.
    const from = endOfDayInZone('2026-03-20', 'Europe/Berlin');
    expect(dateInZone(new Date(from.getTime() + 14 * 86400000), 'Europe/Berlin')).toBe('2026-04-04');
  });

  test('an old midnight-UTC row moves in whole UTC days and stays midnight UTC', () => {
    expect(iso(extendExpiry(new Date('2026-10-28T00:00:00.000Z'), 7, 'America/New_York'))).toBe('2026-11-04T00:00:00.000Z');
  });

  test('any other instant keeps its wall-clock time in the zone', () => {
    // 12:00 Berlin (CET) on 20 Mar → 12:00 Berlin (CEST) on 3 Apr.
    expect(iso(extendExpiry(new Date('2026-03-20T11:00:00.250Z'), 14, 'Europe/Berlin'))).toBe('2026-04-03T10:00:00.250Z');
  });
});

describe('getInstanceTimeZone', () => {
  afterEach(() => { mockProfile.row = null; mockProfile.error = null; });
  const processZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  test('the business profile zone wins', async () => {
    mockProfile.row = { timezone: ' America/New_York ' };
    await expect(getInstanceTimeZone()).resolves.toBe('America/New_York');
  });

  test('a blank or unknown profile zone, or no profile, falls back to the process zone', async () => {
    mockProfile.row = { timezone: '' };
    await expect(getInstanceTimeZone()).resolves.toBe(processZone);
    mockProfile.row = { timezone: 'Mars/Olympus_Mons' };
    await expect(getInstanceTimeZone()).resolves.toBe(processZone);
    mockProfile.row = undefined;
    await expect(getInstanceTimeZone()).resolves.toBe(processZone);
    mockProfile.error = new Error('no such column: timezone');
    await expect(getInstanceTimeZone()).resolves.toBe(processZone);
  });

  test('the process zone is the TZ the server runs in', () => {
    const helper = path.resolve(__dirname, '../../src/utils/galleryExpiry');
    const dbModule = require.resolve('../../src/database/db');
    const out = execFileSync(process.execPath, ['-e', `
      const dbPath = ${JSON.stringify(dbModule)};
      require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true,
        exports: { db: () => { throw new Error('no database here'); } } };
      const { getInstanceTimeZone } = require(${JSON.stringify(helper)});
      getInstanceTimeZone().then((tz) => console.log(tz));
    `], { env: { ...process.env, TZ: 'America/New_York' }, encoding: 'utf8' });
    expect(out.trim()).toBe('America/New_York');
  });
});
