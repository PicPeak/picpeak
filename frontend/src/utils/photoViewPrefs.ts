/**
 * photoViewPrefs — localStorage-backed admin photo-grid preferences.
 *
 * The last-used layout for the event Photos tab (Grid or List), and the
 * list columns the admin hid. Stored per browser/admin pair via
 * localStorage so both persist across page reloads. No server round-trip.
 *
 * The layout keeps its own key; every later preference goes into the JSON
 * object at `picpeak.adminPhotos.prefs` instead of more individual keys
 * (see utils/calendarPrefs.ts for the same convention).
 *
 * The getter swallows malformed values (e.g. someone hand-edits the
 * stored value) and falls back to the documented default — never
 * throws on read.
 */

import { safeGetItem, safeSetItem } from './safeStorage';

const VIEW_KEY = 'picpeak.adminPhotos.view';

export type PhotoViewMode = 'grid' | 'list';

const ALLOWED_VIEWS: ReadonlyArray<PhotoViewMode> = ['grid', 'list'];

/**
 * Return the persisted view or the default ('grid').
 * Safe to call before localStorage exists (SSR / test envs).
 */
export function getPhotoViewMode(): PhotoViewMode {
  const raw = safeGetItem('local', VIEW_KEY);
  if (raw && (ALLOWED_VIEWS as readonly string[]).includes(raw)) {
    return raw as PhotoViewMode;
  }
  return 'grid';
}

/**
 * Persist the active view. Silently no-ops when localStorage is
 * unavailable.
 */
export function setPhotoViewMode(view: PhotoViewMode): void {
  if (!(ALLOWED_VIEWS as readonly string[]).includes(view)) return;
  safeSetItem('local', VIEW_KEY, view);
}

// The list view's optional columns (issue 1739). The photo name, the
// selection box and the row actions are always shown.
export const PHOTO_LIST_COLUMNS = [
  'category', 'credit', 'captured', 'uploaded', 'engagement', 'feedback', 'size',
] as const;
export type PhotoListColumn = typeof PHOTO_LIST_COLUMNS[number];

const PREFS_KEY = 'picpeak.adminPhotos.prefs';

/**
 * The columns the admin hid, or none. The HIDDEN set is stored, not the
 * shown one, so a column added later appears for everyone. Unknown names
 * and malformed values are dropped.
 */
export function getHiddenPhotoColumns(): PhotoListColumn[] {
  try {
    const raw = safeGetItem('local', PREFS_KEY);
    const hidden = raw ? JSON.parse(raw)?.hiddenColumns : null;
    if (!Array.isArray(hidden)) return [];
    return PHOTO_LIST_COLUMNS.filter((column) => hidden.includes(column));
  } catch {
    return [];
  }
}

/** Persist the hidden columns, keeping any other key in the prefs object. */
export function setHiddenPhotoColumns(hidden: readonly PhotoListColumn[]): void {
  let prefs: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(safeGetItem('local', PREFS_KEY) || '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) prefs = parsed;
  } catch {
    // malformed — start over
  }
  prefs.hiddenColumns = PHOTO_LIST_COLUMNS.filter((column) => hidden.includes(column));
  safeSetItem('local', PREFS_KEY, JSON.stringify(prefs));
}
