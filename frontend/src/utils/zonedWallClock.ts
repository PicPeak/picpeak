/**
 * An instant as the wall clock of a named time zone: { day: 'YYYY-MM-DD',
 * time: 'HH:MM' }. Booking slots (#2440) are shown in the business's zone,
 * whatever zone the viewer's browser is in.
 */
export function zonedWallClock(instant: string | Date, timeZone: string): { day: string; time: string } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(instant));
  const get = (type: string) => parts.find((p) => p.type === type)?.value || '00';
  const hour = get('hour') === '24' ? '00' : get('hour');
  return { day: `${get('year')}-${get('month')}-${get('day')}`, time: `${hour}:${get('minute')}` };
}

/** 'YYYY-MM-DD' plus n days (calendar arithmetic, no zone involved). */
export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
}

/** ISO weekday 1 (Mon) … 7 (Sun) of a 'YYYY-MM-DD'. */
export function isoWeekday(day: string): number {
  const [y, m, d] = day.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return dow === 0 ? 7 : dow;
}
