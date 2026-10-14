/**
 * The expiry and delivery due date fields round-trip west of UTC (issue 1975).
 *
 * The expiry field sends a bare 'yyyy-MM-dd', stored as midnight UTC; the
 * form used to read that instant in the browser's zone, so in New York the
 * field showed the previous day and a save moved the expiry back a day.
 * The suite pins TZ itself, so it holds on a UTC CI runner too.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Event } from '../../../../../types';
import { eventFieldsFromEvent, eventUpdatePayload } from '../draft';

const t = (_key: string, fallback: string) => fallback;
const branding = { headerStyle: 'standard' as const, primaryColor: '#222222' };

const event = (fields: Partial<Event> & Record<string, unknown>) => ({
  id: 1,
  slug: 'g',
  event_type: 'wedding',
  event_name: 'G',
  event_date: '2026-06-14',
  source_mode: 'managed',
  ...fields,
}) as unknown as Event;

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

describe('date fields west of UTC (America/New_York)', () => {
  inZone('America/New_York');

  it('runs in the zone it claims', () => {
    expect(new Date('2026-12-24T00:00:00.000Z').getTimezoneOffset()).toBe(300);
  });

  it('shows a stored midnight-UTC expiry as its own date', () => {
    const fields = eventFieldsFromEvent(event({ expires_at: '2026-12-24T00:00:00.000Z' }), branding);
    expect(fields.expires_at).toBe('2026-12-24');
  });

  it('sends the same date back, so an untouched expiry stays put across saves', () => {
    const base = eventFieldsFromEvent(event({ expires_at: '2026-12-24T00:00:00.000Z' }), branding);
    // Another field changes; the expiry is not touched and must not be sent.
    expect(eventUpdatePayload({ ...base, welcome_message: 'Hi' }, base, t)).toEqual({ welcome_message: 'Hi' });
    // Re-picking the date shown is no change either.
    expect(eventUpdatePayload({ ...base, expires_at: '2026-12-24' }, base, t)).toBeNull();
  });

  it('keeps reading a non-midnight expiry (server-local midnight from creation) in the browser zone', () => {
    // 05:00Z is midnight in New York, what a create on a New York server stores.
    const fields = eventFieldsFromEvent(event({ expires_at: '2026-12-24T05:00:00.000Z' }), branding);
    expect(fields.expires_at).toBe('2026-12-24');
  });

  it('shows a stored delivery due date as its UTC date', () => {
    const fields = eventFieldsFromEvent(event({ delivery_due_at: '2026-06-21T12:00:00.000Z' }), branding);
    expect(fields.delivery_due_at).toBe('2026-06-21');
  });
});

describe('date fields east of UTC+12 (Pacific/Kiritimati)', () => {
  inZone('Pacific/Kiritimati');

  it('runs in the zone it claims', () => {
    expect(new Date('2026-06-21T12:00:00.000Z').getTimezoneOffset()).toBe(-840);
  });

  it('shows a stored noon-UTC delivery due date as its UTC date, not the next day', () => {
    const fields = eventFieldsFromEvent(event({ delivery_due_at: '2026-06-21T12:00:00.000Z' }), branding);
    expect(fields.delivery_due_at).toBe('2026-06-21');
  });

  it('shows a stored midnight-UTC expiry as its own date', () => {
    const fields = eventFieldsFromEvent(event({ expires_at: '2026-12-24T00:00:00.000Z' }), branding);
    expect(fields.expires_at).toBe('2026-12-24');
  });
});
