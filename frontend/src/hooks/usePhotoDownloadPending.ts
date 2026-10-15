import { useSyncExternalStore } from 'react';
// The initialised global instance, as utils/downloadLimit.ts uses it.
import i18n from 'i18next';

// Issue 2043: a single-photo download can take seconds before the browser
// shows anything (the photo is fetched as a blob first, and rendered with a
// watermark or at a set resolution on the server). A tap that gets no
// reaction is tapped again, and every tap was another request and another
// saved file. These are the photos whose download is being prepared right
// now, shared by every button that downloads them (tile, carousel,
// lightbox), so each can show it is busy and ignore the repeated tap.
// Keyed by photo id: ids are unique across galleries.
//
// A request that never settles (the API client has no timeout; a phone that
// changed networks) must not lock the photo until a reload, so a mark lets
// go on its own after PHOTO_DOWNLOAD_STALE_MS without progress. A slow download that is
// still arriving reports progress (touchPhotoDownload) and keeps its mark.
// Each mark carries a token, so a late settle of a download whose mark
// already expired cannot clear a newer one.
export const PHOTO_DOWNLOAD_STALE_MS = 60_000;
const pending = new Map<number, { token: number; timer: ReturnType<typeof setTimeout> }>();
const listeners = new Set<() => void>();
let lastToken = 0;

function notify() {
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export const isPhotoDownloadPending = (photoId: number): boolean => pending.has(photoId);

/** Marks the download as started: its token, or null when it already is. */
export function beginPhotoDownload(photoId: number): number | null {
  if (pending.has(photoId)) return null;
  const token = ++lastToken;
  const timer = setTimeout(() => endPhotoDownload(photoId, token), PHOTO_DOWNLOAD_STALE_MS);
  pending.set(photoId, { token, timer });
  notify();
  return token;
}

/** Bytes arrived: the download is alive, so its deadline starts over. */
export function touchPhotoDownload(photoId: number, token: number): void {
  const mark = pending.get(photoId);
  if (!mark || mark.token !== token) return;
  clearTimeout(mark.timer);
  mark.timer = setTimeout(() => endPhotoDownload(photoId, token), PHOTO_DOWNLOAD_STALE_MS);
}

/** The download was handed to the browser, or failed (or its mark went stale). */
export function endPhotoDownload(photoId: number, token?: number): void {
  const mark = pending.get(photoId);
  if (!mark || (token !== undefined && mark.token !== token)) return;
  clearTimeout(mark.timer);
  pending.delete(photoId);
  notify();
}

export function usePhotoDownloadPending(photoId: number | null | undefined): boolean {
  return useSyncExternalStore(subscribe, () => photoId != null && pending.has(photoId));
}

const PREPARING_FALLBACK = 'Preparing your download…';
/** The busy button's label. */
export const preparingDownloadMessage = (): string =>
  // An i18next that is not initialised yet returns nothing.
  i18n.t('gallery.preparingDownload', PREPARING_FALLBACK) || PREPARING_FALLBACK;
