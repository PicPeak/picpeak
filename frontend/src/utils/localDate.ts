import { format } from 'date-fns';

/**
 * Today as yyyy-MM-dd in the browser's own time zone, for a date field's
 * default. `new Date().toISOString().slice(0, 10)` is the UTC date: between
 * midnight and 02:00 in Switzerland it is still yesterday, so a quote or an
 * invoice made then was dated the day before.
 */
export function todayIsoDate(): string {
  return format(new Date(), 'yyyy-MM-dd');
}

/**
 * A stored instant (ISO 8601 with a zone) as the "yyyy-MM-ddTHH:mm" an
 * editor's date + time fields show, in the browser's own time zone. '' when
 * unset or unreadable.
 */
export function toLocalDateTimeInput(iso: string | null | undefined): string {
  const date = iso ? new Date(iso) : null;
  return date && !Number.isNaN(date.getTime()) ? format(date, "yyyy-MM-dd'T'HH:mm") : '';
}

/**
 * The "yyyy-MM-ddTHH:mm" from those fields as an ISO instant, read in the
 * browser's time zone; the API reads a zone-less value as UTC. When the field
 * still shows `loaded`, that instant is returned as it is, so saving
 * unchanged keeps its seconds and the hour a DST change repeats.
 */
export function fromLocalDateTimeInput(local: string, loaded?: string | null): string | undefined {
  if (!local) return undefined;
  if (loaded && toLocalDateTimeInput(loaded) === local) return loaded;
  const date = new Date(local);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}
