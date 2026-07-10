/**
 * photoViewPrefs — localStorage-backed admin photo-grid preferences.
 *
 * Single key today: the last-used layout for the event Photos tab
 * (Grid or List). Stored per browser/admin pair via localStorage so the
 * toggle persists across page reloads. No server round-trip.
 *
 * If more admin-tunable photo preferences land, extend this module with
 * a JSON object keyed at `picpeak.adminPhotos.prefs` instead of more
 * individual keys (see utils/calendarPrefs.ts for the same convention).
 *
 * The getter swallows malformed values (e.g. someone hand-edits the
 * stored value) and falls back to the documented default — never
 * throws on read.
 */

const VIEW_KEY = 'picpeak.adminPhotos.view';

export type PhotoViewMode = 'grid' | 'list';

const ALLOWED_VIEWS: ReadonlyArray<PhotoViewMode> = ['grid', 'list'];

/**
 * Return the persisted view or the default ('grid').
 * Safe to call before localStorage exists (SSR / test envs).
 */
export function getPhotoViewMode(): PhotoViewMode {
  if (typeof window === 'undefined' || !window.localStorage) return 'grid';
  try {
    const raw = window.localStorage.getItem(VIEW_KEY);
    if (raw && (ALLOWED_VIEWS as readonly string[]).includes(raw)) {
      return raw as PhotoViewMode;
    }
  } catch (_) {
    // ignore — fall through to default
  }
  return 'grid';
}

/**
 * Persist the active view. Silently no-ops when localStorage is
 * unavailable.
 */
export function setPhotoViewMode(view: PhotoViewMode): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  if (!(ALLOWED_VIEWS as readonly string[]).includes(view)) return;
  try {
    window.localStorage.setItem(VIEW_KEY, view);
  } catch (_) {
    // ignore — quota / disabled storage
  }
}
