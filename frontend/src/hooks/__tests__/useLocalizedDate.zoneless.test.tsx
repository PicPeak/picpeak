/**
 * SQLite's zone-less CURRENT_TIMESTAMP is UTC (issue 1815). The hook reads
 * that one shape as UTC so every screen that shows a database-default
 * timestamp is right on a SQLite install, not only the two routes the API
 * fix covered.
 *
 * The assertions compare against the same instant written with a `Z`, so
 * they hold in whatever zone the test machine runs.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ i18n: { language: 'en' } }) }));
vi.mock('../usePublicSettings', () => ({
  usePublicSettings: () => ({ data: { general_date_format: 'YYYY-MM-DD', general_time_format: '24h' } }),
}));

import { toDisplayDate, useLocalizedDate } from '../useLocalizedDate';

afterEach(() => { vi.useRealTimers(); });

describe('toDisplayDate', () => {
  it('reads SQLite\'s zone-less timestamp as UTC', () => {
    expect(toDisplayDate('2026-10-05 14:00:00').toISOString()).toBe('2026-10-05T14:00:00.000Z');
    expect(toDisplayDate('2026-10-05 14:00:00.123').toISOString()).toBe('2026-10-05T14:00:00.123Z');
    expect(toDisplayDate(' 2026-10-05 14:00:00 ').toISOString()).toBe('2026-10-05T14:00:00.000Z');
  });

  it('leaves every other shape to the browser', () => {
    // A zone is stated: nothing to add.
    expect(toDisplayDate('2026-10-05T14:00:00.000Z').getTime()).toBe(Date.parse('2026-10-05T14:00:00.000Z'));
    expect(toDisplayDate('2026-10-05T14:00:00+02:00').getTime()).toBe(Date.parse('2026-10-05T12:00:00.000Z'));
    // datetime-local values are local on purpose (the scheduled reveal).
    expect(toDisplayDate('2026-10-05T14:00').getTime()).toBe(new Date(2026, 9, 5, 14, 0).getTime());
    expect(toDisplayDate('2026-10-05T14:00:00').getTime()).toBe(new Date(2026, 9, 5, 14, 0, 0).getTime());
    // A bare calendar date is not a timestamp.
    expect(toDisplayDate('2026-10-05').getTime()).toBe(new Date('2026-10-05').getTime());
    const date = new Date();
    expect(toDisplayDate(date)).toBe(date);
    expect(Number.isNaN(toDisplayDate('not a date').getTime())).toBe(true);
  });
});

describe('useLocalizedDate with a zone-less SQLite timestamp', () => {
  const NAIVE = '2026-10-05 14:00:00';
  const SAME_INSTANT = '2026-10-05T14:00:00Z';

  it('formats it as the same instant as its UTC spelling', () => {
    const { result } = renderHook(() => useLocalizedDate());
    expect(result.current.format(NAIVE)).toBe(result.current.format(SAME_INSTANT));
    expect(result.current.formatTime(NAIVE)).toBe(result.current.formatTime(SAME_INSTANT));
    expect(result.current.formatDateTime(NAIVE)).toBe(result.current.formatDateTime(SAME_INSTANT));
  });

  it('never places a row written a minute ago in the future', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-05T14:01:00Z'));
    const { result } = renderHook(() => useLocalizedDate());
    expect(result.current.formatDistanceToNow(NAIVE, { addSuffix: true })).toBe('1 minute ago');
  });

  it('still shows a bare clock string as that time', () => {
    const { result } = renderHook(() => useLocalizedDate());
    expect(result.current.formatTime('09:00')).toBe('09:00');
  });
});
