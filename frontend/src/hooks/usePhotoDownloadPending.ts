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
const pending = new Set<number>();
const listeners = new Set<() => void>();

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

/** Marks the download as started; false when it already is. */
export function beginPhotoDownload(photoId: number): boolean {
  if (pending.has(photoId)) return false;
  pending.add(photoId);
  notify();
  return true;
}

/** The download was handed to the browser, or failed. */
export function endPhotoDownload(photoId: number): void {
  if (pending.delete(photoId)) notify();
}

export function usePhotoDownloadPending(photoId: number | null | undefined): boolean {
  return useSyncExternalStore(subscribe, () => photoId != null && pending.has(photoId));
}

const PREPARING_FALLBACK = 'Preparing your download…';
/** The busy button's label. */
export const preparingDownloadMessage = (): string =>
  // An i18next that is not initialised yet returns nothing.
  i18n.t('gallery.preparingDownload', PREPARING_FALLBACK) || PREPARING_FALLBACK;
