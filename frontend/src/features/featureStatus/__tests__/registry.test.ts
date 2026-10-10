import { describe, it, expect } from 'vitest';
import { FEATURE_STATUS, NEW_FOR_DAYS, featureState } from '../registry';

describe('featureState', () => {
  const since = '2026-10-08';
  const day = (offset: number) => new Date(Date.parse(`${since}T00:00:00`) + offset * 86_400_000 + 3_600_000);

  it('shows a stable feature as new for 30 days after its date, then as stable', () => {
    const saved = FEATURE_STATUS.galleries;
    FEATURE_STATUS.galleries = { maturity: 'stable', newSince: since };
    try {
      expect(NEW_FOR_DAYS).toBe(30);
      expect(featureState('galleries', day(0))).toBe('new');
      expect(featureState('galleries', day(29))).toBe('new');
      expect(featureState('galleries', day(30))).toBe('stable');
    } finally {
      FEATURE_STATUS.galleries = saved;
    }
  });

  it('keeps beta, experimental and roadmap whatever the date', () => {
    expect(featureState('customerPortal', day(400))).toBe('beta');
    expect(featureState('quotes', day(400))).toBe('beta');
    expect(featureState('crmDevelopment', day(400))).toBe('experimental');
    expect(featureState('calendarBooking', day(400))).toBe('roadmap');
    expect(featureState('portalCalendar', day(400))).toBe('roadmap');
  });

  it('never labels a stable feature without a date', () => {
    expect(featureState('galleries')).toBe('stable');
  });
});
