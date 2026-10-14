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

/**
 * The promise is a calendar date ("by the 20th", stored at noon UTC so it
 * reads the same everywhere): it is overdue once that whole day is over,
 * not at the stored noon. The day ends at the end of its UTC day, the rule
 * the server's overdue reminder uses, so the screen turns red when the
 * overdue mail goes out, whatever the admin's zone. `days` counts calendar
 * days against today's UTC date; `date` is the promised day, local midnight
 * for display.
 */
export function deliveryDue(dueAt: string | null | undefined, now: Date = new Date()): DeliveryDue | null {
  if (!dueAt) return null;
  const parsed = new Date(dueAt);
  if (Number.isNaN(parsed.getTime())) return null;
  const [y, m, d] = parsed.toISOString().slice(0, 10).split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const days = Math.round((Date.UTC(y, m - 1, d) - today) / DAY_MS);
  const tone = days < 0 ? 'overdue' : days <= DUE_SOON_DAYS ? 'soon' : 'ok';
  return { date, days, tone };
}

/** True while the gallery shows a first look and waits for the rest. */
export const isAwaitingFullGallery = (event: { delivery_status?: string | null }) => event.delivery_status === 'partial';
