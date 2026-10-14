import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deliveryDue } from '../deliveryStatus';

// Review of PR 1826, concern 13: a gallery promised "by the 20th" is not
// overdue at noon UTC on the 20th. The day ends at the end of that day in
// the instance time zone (UTC when none is known), the rule the server's
// overdue reminder uses (deliveryService), so the admin screens and the
// overdue mail agree whatever the viewer's zone.
describe('deliveryDue', () => {
  const due = '2026-10-20T12:00:00.000Z';

  it('is not overdue during the promised day', () => {
    expect(deliveryDue(due, new Date('2026-10-20T14:00:00Z'))?.tone).toBe('soon');
    expect(deliveryDue(due, new Date('2026-10-20T23:59:00Z'))?.tone).toBe('soon');
  });

  it('is overdue once the promised day is over', () => {
    expect(deliveryDue(due, new Date('2026-10-21T00:01:00Z'))?.tone).toBe('overdue');
  });

  it('counts calendar days', () => {
    expect(deliveryDue(due, new Date('2026-10-17T23:00:00Z'))?.days).toBe(3);
    expect(deliveryDue(due, new Date('2026-10-10T08:00:00Z'))?.tone).toBe('ok');
  });

  it('is null without a date', () => {
    expect(deliveryDue(null)).toBeNull();
  });
});

function inZone(tz: string) {
  let previous: string | undefined;
  beforeAll(() => {
    previous = process.env.TZ;
    process.env.TZ = tz;
  });
  afterAll(() => {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  });
}

describe.each([
  // 00:30 on the 21st in Berlin, still the 20th in UTC: the server has not
  // sent the overdue mail yet.
  ['Europe/Berlin', -120, '2026-10-20T22:30:00Z', 'soon', 0],
  // 22:00 on the 20th in New York, already the 21st in UTC: the server has.
  ['America/New_York', 240, '2026-10-21T02:00:00Z', 'overdue', -1],
] as const)('in %s', (tz, offset, now, tone, days) => {
  inZone(tz);

  it('runs in the zone it claims', () => {
    expect(new Date(now).getTimezoneOffset()).toBe(offset);
  });

  it('ends the promised day when the server does', () => {
    // No instance zone known: the UTC day, whatever the browser's zone.
    const result = deliveryDue('2026-10-20T12:00:00.000Z', new Date(now));
    expect(result?.tone).toBe(tone);
    expect(result?.days).toBe(days);
    // The promised day itself still displays as the 20th.
    expect(result?.date.getDate()).toBe(20);
  });
});

// One rule with the server: the promised day ends in the INSTANCE zone, not
// the viewer's and not UTC. Promised "by the 24th" (stored at noon UTC).
describe.each([
  // 01:00 on the 25th in Auckland: the 24th is over there.
  ['Pacific/Auckland', '2026-12-24T12:00:00Z', 'overdue', -1],
  // 02:00 on the 25th on Kiritimati (UTC+14).
  ['Pacific/Kiritimati', '2026-12-24T12:00:00Z', 'overdue', -1],
  // 15:00 on the 24th in Honolulu, already the 25th in UTC: still due today.
  ['Pacific/Honolulu', '2026-12-25T01:00:00Z', 'soon', 0],
  // 23:59 on the 24th in Honolulu: the last minute of the promised day.
  ['Pacific/Honolulu', '2026-12-25T09:59:00Z', 'soon', 0],
  ['Pacific/Honolulu', '2026-12-25T10:00:00Z', 'overdue', -1],
] as const)('with instance zone %s at %s', (instanceZone, now, tone, days) => {
  // The browser sits somewhere else entirely.
  inZone('Europe/Berlin');

  it('ends the promised day at the end of that day in the instance zone', () => {
    const result = deliveryDue('2026-12-24T12:00:00.000Z', new Date(now), instanceZone);
    expect(result?.tone).toBe(tone);
    expect(result?.days).toBe(days);
    expect(result?.date.getDate()).toBe(24);
  });
});

describe('an unknown instance zone', () => {
  it('falls back to the UTC day', () => {
    expect(deliveryDue('2026-12-24T12:00:00.000Z', new Date('2026-12-25T01:00:00Z'), 'Not/AZone')?.tone).toBe('overdue');
  });
});
