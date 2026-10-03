/**
 * Link to a single photo (issue 1733, backlog item B4).
 *
 * The lightbox mirrors its photo to `?photo=<id>`, next to the `?folder=`
 * sync in folders.ts, so a guest can send someone exactly the picture they
 * are looking at. History is managed so the back button behaves like an
 * ordinary modal:
 *
 *   - opening the lightbox from a tile PUSHES one entry (flagged in its
 *     history state), stepping prev/next REPLACES it, and closing goes BACK
 *     to the entry underneath;
 *   - a lightbox opened from a deep link pushed nothing, so closing it
 *     REPLACES the param away instead — `history.back()` there would leave
 *     the site.
 *
 * NOTE: the id is only ever resolved against the photo list the viewer has
 * already loaded (see `resolvePhotoLink`). A link to a photo this viewer may
 * not see resolves to nothing and the param is dropped; it never fetches a
 * photo by id and never bypasses the password prompt, which GalleryPage
 * renders in place without touching the query string.
 */
import type { Photo, PhotoCategory } from '../../types';
import { folderCategoryIds } from './folders';

export const PHOTO_QUERY_PARAM = 'photo';

/**
 * How a lightbox reports its photo to the container: `open` from a tile
 * (push), `step` prev/next inside it (replace), `close` (back or drop).
 */
export type LightboxPhotoChangeReason = 'open' | 'step' | 'close';
export type LightboxPhotoChangeHandler = (photoId: number | null, reason: LightboxPhotoChangeReason) => void;

/** Marks the history entry the lightbox pushed, so closing knows to go back. */
const PUSHED_STATE_KEY = 'photoPushed';

/** Read the linked photo id from the address bar; null when absent or not an id. */
export function readPhotoParam(): number | null {
  if (typeof window === 'undefined') return null;
  const raw = new URLSearchParams(window.location.search).get(PHOTO_QUERY_PARAM);
  if (raw === null || !/^\d+$/.test(raw)) return null;
  return Number(raw);
}

export interface ResolvedPhotoLink {
  photo: Photo;
  /** The folder the photo lives in, or null when it belongs to root. */
  folder: PhotoCategory | null;
}

/**
 * The photo a `?photo=<id>` points at, or null for an id that is not in the
 * loaded list. Also says which folder has to be open for the photo to be on
 * screen: a foldered photo is absent from the root grid (folders.ts), so a
 * deep link to it has to switch folders first.
 */
export function resolvePhotoLink(
  photos: Photo[] | undefined,
  categories: PhotoCategory[] | undefined,
  photoId: number | null
): ResolvedPhotoLink | null {
  if (photoId === null) return null;
  const photo = (photos || []).find((p) => p.id === photoId);
  if (!photo) return null;
  const folder = photo.category_id && folderCategoryIds(categories).has(photo.category_id)
    ? (categories || []).find((c) => c.id === photo.category_id) || null
    : null;
  return { photo, folder };
}

function urlWithPhoto(photoId: number | null): string {
  const url = new URL(window.location.href);
  if (photoId === null) {
    url.searchParams.delete(PHOTO_QUERY_PARAM);
  } else {
    url.searchParams.set(PHOTO_QUERY_PARAM, String(photoId));
  }
  return url.toString();
}

/**
 * Opening from a tile: one new history entry, so Back closes the lightbox.
 * Existing state is kept — the router stores its own fields there.
 */
export function pushPhotoParam(photoId: number): void {
  if (typeof window === 'undefined') return;
  window.history.pushState(
    { ...(window.history.state || {}), [PHOTO_QUERY_PARAM]: photoId, [PUSHED_STATE_KEY]: true },
    '',
    urlWithPhoto(photoId)
  );
}

/**
 * Stepping inside the lightbox: rewrite the current entry. Keeps the pushed
 * flag, so a close after any number of steps still goes back exactly once.
 */
export function replacePhotoParam(photoId: number | null): void {
  if (typeof window === 'undefined') return;
  // Already there (the lightbox reports its opening photo once more as a
  // step): nothing to rewrite.
  if (readPhotoParam() === photoId) return;
  const state = { ...(window.history.state || {}) };
  if (photoId === null) {
    delete state[PHOTO_QUERY_PARAM];
    delete state[PUSHED_STATE_KEY];
  } else {
    state[PHOTO_QUERY_PARAM] = photoId;
  }
  window.history.replaceState(state, '', urlWithPhoto(photoId));
}

/**
 * Closing the lightbox. Back to the entry underneath when the lightbox pushed
 * one; otherwise (deep link, or a Forward onto an entry the lightbox did not
 * create) just drop the param, because the entry underneath may be another
 * site.
 */
export function leavePhotoParam(): void {
  if (typeof window === 'undefined') return;
  if (window.history.state?.[PUSHED_STATE_KEY] === true) {
    window.history.back();
    return;
  }
  if (readPhotoParam() !== null) replacePhotoParam(null);
}
