/**
 * A photo's capture time reaches the admin list as the camera's wall clock,
 * 'YYYY-MM-DDTHH:MM:SS' with no zone (issue 1739). It is shown as sent: no
 * shift to the browser's zone, whatever zone the test machine runs in.
 */
import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ i18n: { language: 'en' } }) }));
let timeFormat = '24h';
vi.mock('../usePublicSettings', () => ({
  usePublicSettings: () => ({ data: { general_date_format: 'DD.MM.YYYY', general_time_format: timeFormat } }),
}));

import { parseWallClock, useLocalizedDate } from '../useLocalizedDate';

describe('parseWallClock', () => {
  it('splits the value into its day and clock', () => {
    const parsed = parseWallClock('2026-03-29T02:30:15');
    expect(parsed?.time).toBe('02:30');
    expect([parsed?.day.getFullYear(), parsed?.day.getMonth(), parsed?.day.getDate()]).toEqual([2026, 2, 29]);
  });

  it('rejects anything that is not a zone-less wall clock', () => {
    for (const value of [null, undefined, '', 'nope', '2026-06-03', '2026-06-03T12:00:00Z',
      '2026-06-03T12:00:00+02:00', '2026-02-30T12:00:00', '2026-06-03T24:00:00']) {
      expect(parseWallClock(value)).toBeNull();
    }
  });
});

describe('formatWallClock', () => {
  it('shows the clock as sent, late at night and in a DST gap', () => {
    const { result } = renderHook(() => useLocalizedDate());
    expect(result.current.formatWallClock('2026-06-03T23:45:10')).toBe('03.06.2026 23:45');
    expect(result.current.formatWallClock('2026-01-01T00:05:00')).toBe('01.01.2026 00:05');
    // 02:30 does not exist on this day in most European zones.
    expect(result.current.formatWallClock('2026-03-29T02:30:00')).toBe('29.03.2026 02:30');
  });

  it('follows the 12-hour setting', () => {
    timeFormat = '12h';
    const { result } = renderHook(() => useLocalizedDate());
    expect(result.current.formatWallClock('2026-06-03T23:45:10')).toBe('03.06.2026 11:45 PM');
    timeFormat = '24h';
  });

  it('is empty for no value', () => {
    const { result } = renderHook(() => useLocalizedDate());
    expect(result.current.formatWallClock(null)).toBe('');
    expect(result.current.formatWallClock('garbage')).toBe('');
  });
});
