/**
 * calendarPrefs — localStorage-backed admin calendar preferences.
 *
 * Single key today: the last-used view (Month or Week). Stored per
 * browser/admin pair via localStorage so the toggle persists across
 * page reloads. No server round-trip.
 *
 * If more admin-tunable preferences land (e.g. default week start,
 * legend visibility), extend this module with a JSON object keyed at
 * `picpeak.calendar.prefs` instead of more individual keys.
 *
 * The getter swallows malformed values (e.g. someone hand-edits the
 * stored value) and falls back to the documented default — never
 * throws on read.
 */

const VIEW_KEY = 'picpeak.calendar.view';

export type CalendarView = 'dayGridMonth' | 'timeGridWeek';

const ALLOWED_VIEWS: ReadonlyArray<CalendarView> = ['dayGridMonth', 'timeGridWeek'];

/**
 * Return the persisted view or the default ('dayGridMonth' — Month).
 * Safe to call before localStorage exists (SSR / test envs).
 */
export function getCalendarView(): CalendarView {
  if (typeof window === 'undefined' || !window.localStorage) return 'dayGridMonth';
  try {
    const raw = window.localStorage.getItem(VIEW_KEY);
    if (raw && (ALLOWED_VIEWS as readonly string[]).includes(raw)) {
      return raw as CalendarView;
    }
  } catch (_) {
    // ignore — fall through to default
  }
  return 'dayGridMonth';
}

/**
 * Persist the active view. Silently no-ops when localStorage is
 * unavailable.
 */
export function setCalendarView(view: CalendarView): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  if (!(ALLOWED_VIEWS as readonly string[]).includes(view)) return;
  try {
    window.localStorage.setItem(VIEW_KEY, view);
  } catch (_) {
    // ignore — quota / disabled storage
  }
}
