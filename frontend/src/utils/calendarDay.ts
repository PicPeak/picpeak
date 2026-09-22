/**
 * A deadline stored as an instant but meant as a calendar day (document
 * requests store the picked day at noon UTC): the UTC date part, as a local
 * midnight, so formatting it names that day in every timezone.
 */
export function calendarDay(iso: string): Date | string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : iso;
}
