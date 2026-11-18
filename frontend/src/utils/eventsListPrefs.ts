/**
 * eventsListPrefs — the sort the admin last picked on the galleries list.
 *
 * The list keeps its sort in the URL (`?sort=&dir=`), which covers a reload
 * and the Back button but not the sidebar link, the "back to galleries"
 * buttons or a new tab: those open `/admin/events` bare and the table fell
 * back to the server default. The last explicit choice is kept here, per
 * browser, and used whenever the URL carries no sort of its own.
 *
 * Reads never throw: a malformed or hand-edited value, or blocked storage,
 * reads as "nothing stored".
 */
import type { EventSortBy } from '../services/events.service';

const SORT_KEY = 'picpeak.eventsList.sort';

/**
 * The sort keys the list's column menus can produce. A URL or stored value
 * carrying anything else is dropped rather than forwarded: the server would
 * discard it and fall back to created_at desc, leaving the table in an order
 * no header reflects.
 */
export const EVENTS_LIST_SORT_KEYS: readonly EventSortBy[] = [
  'event_name', 'event_date', 'created_at', 'photo_count', 'status', 'expires_at',
];

export type EventsListSort = { sortBy: EventSortBy; sortOrder: 'asc' | 'desc' };

/** Both halves valid, or null. */
export function parseEventsListSort(by: string | null, dir: string | null): EventsListSort | null {
  if (dir !== 'asc' && dir !== 'desc') return null;
  if (!(EVENTS_LIST_SORT_KEYS as readonly string[]).includes(by ?? '')) return null;
  return { sortBy: by as EventSortBy, sortOrder: dir };
}

export function getEventsListSort(): EventsListSort | null {
  if (typeof window === 'undefined' || !window.localStorage) return null;
  try {
    const raw = window.localStorage.getItem(SORT_KEY);
    if (!raw) return null;
    const [by, dir] = raw.split(':');
    return parseEventsListSort(by, dir ?? null);
  } catch {
    return null;
  }
}

export function setEventsListSort(sort: EventsListSort): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  if (!parseEventsListSort(sort.sortBy, sort.sortOrder)) return;
  try {
    window.localStorage.setItem(SORT_KEY, `${sort.sortBy}:${sort.sortOrder}`);
  } catch {
    // ignore — quota / disabled storage
  }
}
