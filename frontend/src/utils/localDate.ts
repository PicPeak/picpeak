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
