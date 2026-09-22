import { describe, it, expect } from 'vitest';
import { calendarDay } from '../calendarDay';

describe('calendarDay', () => {
  it('is the UTC date as a local day, so no timezone moves it', () => {
    for (const iso of ['2026-09-22T12:00:00.000Z', '2026-09-22T00:00:00.000Z', '2026-09-22T23:59:59.000Z']) {
      const d = calendarDay(iso) as Date;
      expect([d.getFullYear(), d.getMonth(), d.getDate()]).toEqual([2026, 8, 22]);
    }
  });

  it('passes anything else through for the formatter to reject', () => {
    expect(calendarDay('soon')).toBe('soon');
  });
});
