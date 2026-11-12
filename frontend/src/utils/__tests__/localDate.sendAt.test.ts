import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fromLocalDateTimeInput, toLocalDateTimeInput } from '../localDate';

// The invoice editor's scheduled-send fields (issue 2455) in a zone east of UTC.
describe('scheduled send time in local time (Europe/Zurich)', () => {
  const previousTz = process.env.TZ;
  beforeAll(() => { process.env.TZ = 'Europe/Zurich'; });
  afterAll(() => { process.env.TZ = previousTz; });

  it('runs in Zurich time', () => {
    expect(new Date('2026-07-01T07:00:00.000Z').getTimezoneOffset()).toBe(-120);
    expect(new Date('2026-01-15T08:00:00.000Z').getTimezoneOffset()).toBe(-60);
  });

  it('shows the stored instant as local time', () => {
    expect(toLocalDateTimeInput('2026-07-01T07:00:00.000Z')).toBe('2026-07-01T09:00');
    expect(toLocalDateTimeInput('2026-01-15T08:00:00.000Z')).toBe('2026-01-15T09:00');
    expect(toLocalDateTimeInput('2026-01-15T23:30:00.000Z')).toBe('2026-01-16T00:30');
    expect(toLocalDateTimeInput(null)).toBe('');
    expect(toLocalDateTimeInput('nonsense')).toBe('');
  });

  it('sends typed local time as an instant', () => {
    expect(fromLocalDateTimeInput('2026-07-01T09:00')).toBe('2026-07-01T07:00:00.000Z');
    expect(fromLocalDateTimeInput('2026-01-15T09:00')).toBe('2026-01-15T08:00:00.000Z');
    expect(fromLocalDateTimeInput('')).toBeUndefined();
  });

  it('a changed field replaces the loaded instant', () => {
    expect(fromLocalDateTimeInput('2026-07-02T09:00', '2026-07-01T07:00:00.000Z')).toBe('2026-07-02T07:00:00.000Z');
  });

  it('saving unchanged keeps the same instant', () => {
    for (const iso of [
      '2026-07-01T07:00:00.000Z',
      '2026-01-15T08:00:00.000Z',
      '2026-01-15T08:00:42.123Z', // seconds the fields cannot show
      '2026-10-25T01:30:00.000Z', // 02:30 CET, the hour the DST change repeats
    ]) {
      expect(fromLocalDateTimeInput(toLocalDateTimeInput(iso), iso)).toBe(iso);
    }
  });
});
