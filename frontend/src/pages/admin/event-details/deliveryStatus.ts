import { useCallback } from 'react';
import { usePublicSettings } from '../../../hooks/usePublicSettings';

/**
 * How close a two-stage delivery is to its promised date (issue 1562), shared
 * by the Delivery settings, the event header and the event list so all three
 * colour a gallery the same way: amber within two days, red once overdue.
 */
export interface DeliveryDue {
  date: Date;
  /** Whole days left; negative once overdue. */
  days: number;
  tone: 'ok' | 'soon' | 'overdue';
}

const DAY_MS = 864e5;
export const DUE_SOON_DAYS = 2;

/** Today's calendar day in `timeZone` as [y, m, d]; the UTC day for a zone Intl does not know. */
function todayIn(now: Date, timeZone: string): [number, number, number] {
  try {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
        .formatToParts(now)
        .map((p) => [p.type, p.value]),
    );
    return [Number(parts.year), Number(parts.month), Number(parts.day)];
  } catch {
    return [now.getUTCFullYear(), now.getUTCMonth() + 1, now.getUTCDate()];
  }
}

/**
 * The promise is a calendar date ("by the 20th", stored at noon UTC so it
 * reads the same everywhere): it is overdue once that whole day is over,
 * not at the stored noon. The day ends at the end of that day in the
 * instance time zone (`timeZone`, the public settings' expiry_time_zone),
 * the rule the server's overdue reminder uses, so the screen turns red when
 * the overdue mail goes out, whatever the admin's zone. `days` counts
 * calendar days against today's date in that zone; `date` is the promised
 * day, local midnight for display. Without a zone, UTC.
 */
export function deliveryDue(
  dueAt: string | null | undefined,
  now: Date = new Date(),
  timeZone?: string | null,
): DeliveryDue | null {
  if (!dueAt) return null;
  const parsed = new Date(dueAt);
  if (Number.isNaN(parsed.getTime())) return null;
  const [y, m, d] = parsed.toISOString().slice(0, 10).split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const [ty, tm, td] = todayIn(now, timeZone || 'UTC');
  const days = Math.round((Date.UTC(y, m - 1, d) - Date.UTC(ty, tm - 1, td)) / DAY_MS);
  const tone = days < 0 ? 'overdue' : days <= DUE_SOON_DAYS ? 'soon' : 'ok';
  return { date, days, tone };
}

/**
 * deliveryDue() bound to the instance time zone from the public settings.
 * Null until the settings have answered, so a badge never shows the UTC
 * day's tone first and then flips; if they fail, the UTC day.
 */
export function useDeliveryDue() {
  const { data: settings, isPending } = usePublicSettings();
  const timeZone = settings?.expiry_time_zone;
  return useCallback(
    (dueAt: string | null | undefined) => (isPending ? null : deliveryDue(dueAt, new Date(), timeZone)),
    [isPending, timeZone],
  );
}

/** True while the gallery shows a first look and waits for the rest. */
export const isAwaitingFullGallery = (event: { delivery_status?: string | null }) => event.delivery_status === 'partial';
