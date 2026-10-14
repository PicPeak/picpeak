/**
 * Every view names a gallery expiry as the day it stands for in the instance
 * time zone (public settings' expiry_time_zone), the day the settings date
 * field shows, not the browser date of the stored instant. The suite pins
 * the browser's TZ itself, so it holds on a UTC CI runner too.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

let timeZone: string | null = 'America/New_York';
vi.mock('react-i18next', () => ({ useTranslation: () => ({ i18n: { language: 'en' } }) }));
vi.mock('../usePublicSettings', () => ({
  usePublicSettings: () => ({ data: { general_date_format: 'YYYY-MM-DD', expiry_time_zone: timeZone } }),
}));

import { useLocalizedDate } from '../useLocalizedDate';

let previousTz: string | undefined;
beforeAll(() => {
  previousTz = process.env.TZ;
  process.env.TZ = 'Europe/Berlin';
});
afterAll(() => {
  if (previousTz === undefined) delete process.env.TZ;
  else process.env.TZ = previousTz;
});

// End of 24 Dec 2026 in New York, as the server stores a picked date.
const END_OF_DAY_NEW_YORK = '2026-12-25T04:59:59.999Z';

describe('formatExpiry, browser in Berlin, instance in New York', () => {
  it('runs in the zone it claims', () => {
    expect(new Date('2026-12-24T00:00:00.000Z').getTimezoneOffset()).toBe(-60);
  });

  it('names the day the expiry ends, where format() names the browser date', () => {
    const { result } = renderHook(() => useLocalizedDate());
    expect(result.current.format(END_OF_DAY_NEW_YORK)).toBe('2026-12-25');
    expect(result.current.formatExpiry(END_OF_DAY_NEW_YORK)).toBe('2026-12-24');
    expect(result.current.formatExpiry(END_OF_DAY_NEW_YORK, 'd MMM yyyy')).toBe('24 Dec 2026');
  });

  it('reads epoch milliseconds (a SQLite row) like the ISO spelling', () => {
    const { result } = renderHook(() => useLocalizedDate());
    expect(result.current.formatExpiry(Date.parse(END_OF_DAY_NEW_YORK))).toBe('2026-12-24');
  });

  it('reads an old midnight-UTC row as its UTC date', () => {
    const { result } = renderHook(() => useLocalizedDate());
    expect(result.current.formatExpiry('2026-12-24T00:00:00.000Z')).toBe('2026-12-24');
  });

  it('falls back to the browser zone before the settings name one, and is blank for a bad value', () => {
    timeZone = null;
    try {
      const { result } = renderHook(() => useLocalizedDate());
      expect(result.current.formatExpiry(END_OF_DAY_NEW_YORK)).toBe('2026-12-25');
      expect(result.current.formatExpiry('not a date')).toBe('');
    } finally {
      timeZone = 'America/New_York';
    }
  });
});
