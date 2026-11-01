/**
 * formatShortDate on the customer portal and public pages: a bare
 * 'YYYY-MM-DD' (a `date` column) is that day in the viewer's zone, not UTC
 * midnight, which west of UTC is the evening before (issue 2330). The suite
 * pins the TZ itself, so it holds on a UTC CI runner too.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useTranslation: () => ({ i18n: { language: 'en' } }),
}));

import { formatShortDate } from '../dateShort';

let previousTz: string | undefined;
beforeAll(() => { previousTz = process.env.TZ; process.env.TZ = 'America/New_York'; });
afterAll(() => { if (previousTz === undefined) delete process.env.TZ; else process.env.TZ = previousTz; });

describe('formatShortDate, browser in New York', () => {
  it('shows a bare calendar day as written', () => {
    expect(formatShortDate('2026-03-01')).toBe('01.03.2026');
  });

  it('still reads a timestamp as its instant', () => {
    expect(formatShortDate('2026-03-01T02:00:00.000Z')).toBe('28.02.2026');
  });

  it('keeps empty and unparseable input as before', () => {
    expect(formatShortDate(null)).toBe('');
    expect(formatShortDate('soon')).toBe('soon');
  });
});
