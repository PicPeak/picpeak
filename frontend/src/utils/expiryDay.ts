import { format } from 'date-fns';

/**
 * The calendar day a stored gallery expiry stands for, as 'yyyy-MM-dd'
 * (follow-up to issue 1975). A picked date is stored as the end of that day
 * in the instance time zone (`timeZone`: the event detail payload's
 * expiry_time_zone, or the public settings' instance_time_zone), so the
 * instant is read back in that zone, wherever the viewer is. Older rows keep
 * their shapes: the settings field used to store midnight UTC, read as its
 * UTC date; event creation and duplication stored the server's local
 * midnight, which is its day in the instance zone when that is the server
 * zone. Without a usable zone, the browser's.
 */
export function expiryDay(date: Date, timeZone?: string | null): string {
  if (Number.isNaN(date.getTime())) return '';
  const iso = date.toISOString();
  if (iso.endsWith('T00:00:00.000Z')) return iso.slice(0, 10);
  if (timeZone) {
    try {
      const parts = Object.fromEntries(
        new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
          .formatToParts(date)
          .map((p) => [p.type, p.value]),
      );
      return `${parts.year}-${parts.month}-${parts.day}`;
    } catch {
      // An unknown zone: fall through to the browser's.
    }
  }
  return format(date, 'yyyy-MM-dd');
}
