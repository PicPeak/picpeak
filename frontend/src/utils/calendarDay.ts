/**
 * A deadline stored as an instant but meant as a calendar day (document
 * requests store the picked day at noon UTC): the UTC date part, as a local
 * midnight, so formatting it names that day in every timezone.
 */
export function calendarDay(iso: string): Date | string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : iso;
}

/**
 * A `date` column: 'YYYY-MM-DD', a calendar day with no time (issue 2330).
 * `new Date()` reads it as UTC midnight, which west of UTC is the evening of
 * the day before, so it is built as that day at local noon instead, where no
 * DST gap can move it. Null when the text is not that shape; Invalid Date for
 * a day that does not exist (30 Feb), rather than rolling it over.
 */
const BARE_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

export function parseCalendarDay(text: string): Date | null {
  const day = BARE_DAY.exec(text.trim());
  if (!day) return null;
  const [, y, mo, d] = day;
  const local = new Date(Number(y), Number(mo) - 1, Number(d), 12);
  return local.getMonth() === Number(mo) - 1 && local.getDate() === Number(d) ? local : new Date(NaN);
}
