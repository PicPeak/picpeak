/**
 * The expiry date field reads the stored instant back in the instance time
 * zone (follow-up to issue 1975). A picked date is stored as the end of that
 * day there, which in a browser in another zone can be the next day; the
 * event detail payload names the zone (expiry_time_zone). The suite pins the
 * browser's TZ itself, so it holds on a UTC CI runner too.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Event } from '../../../../../types';
import { eventFieldsFromEvent, eventUpdatePayload, expiryDateField } from '../draft';

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

// End of 24 Dec 2026 in each instance zone, as the server stores it.
const END_OF_DAY_NEW_YORK = '2026-12-25T04:59:59.999Z';
const END_OF_DAY_BERLIN = '2026-12-24T22:59:59.999Z';

describe('browser in Berlin, instance in New York', () => {
  inZone('Europe/Berlin');

  it('runs in the zone it claims', () => {
    expect(new Date('2026-12-24T00:00:00.000Z').getTimezoneOffset()).toBe(-60);
  });

  it('shows an end-of-day expiry as the day it ends, not the browser date of the instant', () => {
    const fields = eventFieldsFromEvent(
      event({ expires_at: END_OF_DAY_NEW_YORK, expiry_time_zone: 'America/New_York' }),
      branding,
    );
    expect(fields.expires_at).toBe('2026-12-24');
  });

  it('round-trips: an untouched expiry is not sent, re-picking the shown day is no change', () => {
    const base = eventFieldsFromEvent(
      event({ expires_at: END_OF_DAY_NEW_YORK, expiry_time_zone: 'America/New_York' }),
      branding,
    );
    expect(eventUpdatePayload({ ...base, welcome_message: 'Hi' }, base, t)).toEqual({ welcome_message: 'Hi' });
    expect(eventUpdatePayload({ ...base, expires_at: '2026-12-24' }, base, t)).toBeNull();
  });

  it('still shows an old midnight-UTC row as its UTC date', () => {
    expect(expiryDateField('2026-12-24T00:00:00.000Z', 'America/New_York')).toBe('2026-12-24');
  });

  it('shows an old creation row (New York server midnight) as its day', () => {
    expect(expiryDateField('2026-12-24T05:00:00.000Z', 'America/New_York')).toBe('2026-12-24');
  });

  it('falls back to the browser zone without a usable instance zone', () => {
    expect(expiryDateField(END_OF_DAY_NEW_YORK, null)).toBe('2026-12-25');
    expect(expiryDateField(END_OF_DAY_NEW_YORK, 'Mars/Olympus_Mons')).toBe('2026-12-25');
  });
});

describe('browser east of UTC+12 (Pacific/Kiritimati), instance in Berlin', () => {
  inZone('Pacific/Kiritimati');

  it('runs in the zone it claims', () => {
    expect(new Date('2026-12-24T00:00:00.000Z').getTimezoneOffset()).toBe(-840);
  });

  it('shows an end-of-day expiry as the day it ends', () => {
    expect(expiryDateField(END_OF_DAY_BERLIN, 'Europe/Berlin')).toBe('2026-12-24');
  });

  it('shows an old Berlin creation row (local midnight) as its day', () => {
    expect(expiryDateField('2026-12-23T23:00:00.000Z', 'Europe/Berlin')).toBe('2026-12-24');
  });
});
