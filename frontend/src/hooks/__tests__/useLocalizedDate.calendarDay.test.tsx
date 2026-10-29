/**
 * A `date` column reaches the browser as a bare 'YYYY-MM-DD' (issue 2330).
 * Read as UTC midnight it formats as the day before anywhere west of UTC, so
 * a contract issued on 1 March showed "Issued: Feb 28" in New York. The suite
 * pins the browser's TZ itself, so it holds on a UTC CI runner too.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ i18n: { language: 'en' } }) }));
vi.mock('../usePublicSettings', () => ({
  usePublicSettings: () => ({ data: { general_date_format: 'YYYY-MM-DD', general_time_format: '24h' } }),
}));

import { toDisplayDate, useLocalizedDate } from '../useLocalizedDate';

let previousTz: string | undefined;
beforeAll(() => {
  previousTz = process.env.TZ;
  process.env.TZ = 'America/New_York';
});
afterAll(() => {
  if (previousTz === undefined) delete process.env.TZ;
  else process.env.TZ = previousTz;
});

describe('a bare calendar day, browser in New York', () => {
  it('formats as the written day', () => {
    const { result } = renderHook(() => useLocalizedDate());
    expect(result.current.format('2026-03-01')).toBe('2026-03-01');
    expect(result.current.format('2026-01-01')).toBe('2026-01-01');
  });

  it('keeps the day across a DST change', () => {
    // 8 March 2026: New York springs forward at 02:00.
    const { result } = renderHook(() => useLocalizedDate());
    expect(result.current.format('2026-03-08')).toBe('2026-03-08');
    expect(result.current.format('2026-11-01')).toBe('2026-11-01');
  });

  it('rejects a day that does not exist', () => {
    expect(Number.isNaN(toDisplayDate('2026-02-30').getTime())).toBe(true);
    const { result } = renderHook(() => useLocalizedDate());
    expect(result.current.format('2026-02-30')).toBe('');
  });

  it('still reads a timestamp as its instant', () => {
    const { result } = renderHook(() => useLocalizedDate());
    expect(result.current.format('2026-03-01T02:00:00.000Z')).toBe('2026-02-28');
  });
});
