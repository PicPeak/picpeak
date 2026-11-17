/**
 * Optimistic likes for the layouts that keep their own liked set (Premium,
 * Story). The set follows every photo payload, since per-viewer `is_liked`
 * is the server's truth, but a like the viewer just toggled holds the state
 * asked for until a payload agrees: the saved like reaches the photos only
 * through the parent's refresh, and any payload before that one (another
 * photo's refresh, a filter change) still carries the old value. Once saved,
 * the hold lapses after a few seconds even unconfirmed, so a change made
 * elsewhere (another tab) is not overridden for good.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Photo } from '../../../types';
import { LIKES_CLEARED_EVENT } from '../../../utils/feedbackEvents';

// The confirming refresh normally lands well inside this.
export const LIKE_CONFIRM_WINDOW_MS = 5000;

// A hold whose submit never reports back still lapses after this.
export const LIKE_PENDING_MAX_MS = 60000;

export type LikeHolds = Map<number, { liked: boolean; savedAt?: number; heldAt?: number }>;

/** Hold `liked` for this photo until a payload confirms it. */
export function holdLike(holds: LikeHolds, photoId: number, liked: boolean, now = Date.now()) {
  holds.set(photoId, { liked, heldAt: now });
}

/** The submit succeeded: start the confirmation window. */
export function markLikeSaved(holds: LikeHolds, photoId: number, now = Date.now()) {
  const hold = holds.get(photoId);
  if (hold) hold.savedAt = now;
}

/**
 * The liked set for a payload: its own `is_liked`, with every hold still
 * awaiting confirmation applied on top. Drops holds the payload confirms
 * and saved holds older than the window.
 */
export function likedFromPayload(photos: Photo[], holds: LikeHolds, now = Date.now()): Set<number> {
  holds.forEach((hold, id) => {
    if (hold.savedAt !== undefined && now - hold.savedAt > LIKE_CONFIRM_WINDOW_MS) holds.delete(id);
    else if (hold.savedAt === undefined && hold.heldAt !== undefined && now - hold.heldAt > LIKE_PENDING_MAX_MS) holds.delete(id);
  });
  // Only a settled hold: a payload from before a write that is still running
  // can agree with it by chance (like, then unlike before the first refresh).
  photos.forEach((photo) => {
    const hold = holds.get(photo.id);
    if (hold?.savedAt !== undefined && hold.liked === !!photo.is_liked) holds.delete(photo.id);
  });
  const liked = new Set(photos.filter((photo) => photo.is_liked).map((photo) => photo.id));
  holds.forEach(({ liked: held }, id) => {
    if (held) liked.add(id);
    else liked.delete(id);
  });
  return liked;
}

/**
 * The viewer's liked set for a layout whose tiles toggle a like and report it
 * only through the row refresh that follows (issue 2561). Grid, Masonry,
 * Carousel, Timeline and Mosaic seeded their set from the first payload and
 * then ignored every later one, so a like changed in the lightbox never
 * reached the tile: the heart showed the opposite of what the server held,
 * and the next click on it (a toggle) did the opposite of what the guest
 * meant. Here the set follows each payload, and a toggle holds its state
 * while its submit runs and for the confirmation window after the tile
 * reports it settled: pass the tiles `settled` as their onFeedbackChange.
 */
export function useViewerLikes(
  photos: Photo[],
  onFeedbackChange?: (photoId?: number) => void,
  slug?: string,
): [Set<number>, (photoId: number) => void, (photoId?: number) => void, (photoId: number) => void] {
  const holdsRef = useRef<LikeHolds>(new Map());
  const [liked, setLiked] = useState<Set<number>>(() => likedFromPayload(photos, holdsRef.current));
  // Submits still running per photo: a quick like-unlike sends two, and the
  // first one finishing must not settle the hold of the second.
  const runningRef = useRef<Map<number, number>>(new Map());
  const photosRef = useRef(photos);
  photosRef.current = photos;
  useEffect(() => {
    setLiked(likedFromPayload(photos, holdsRef.current));
  }, [photos]);
  // All own likes were taken back: a held click is no longer what the server
  // holds, and the refresh that follows must show through.
  useEffect(() => {
    const onCleared = (event: Event) => {
      // Another gallery's removal (still finishing after a navigation) says
      // nothing about the likes held here.
      if ((event as CustomEvent<{ slug?: string }>).detail?.slug !== slug) return;
      holdsRef.current.clear();
      runningRef.current.clear();
      setLiked(likedFromPayload(photosRef.current, holdsRef.current));
    };
    window.addEventListener(LIKES_CLEARED_EVENT, onCleared);
    return () => window.removeEventListener(LIKES_CLEARED_EVENT, onCleared);
  }, [slug]);
  const toggle = useCallback((photoId: number) => {
    runningRef.current.set(photoId, (runningRef.current.get(photoId) ?? 0) + 1);
    setLiked((previous) => {
      const next = new Set(previous);
      const nowLiked = !next.has(photoId);
      if (nowLiked) next.add(photoId);
      else next.delete(photoId);
      holdLike(holdsRef.current, photoId, nowLiked);
      return next;
    });
  }, []);
  // The tile's submit finished (or failed): once none is left running, start
  // the confirmation window; then refresh the row as before.
  const settled = useCallback((photoId?: number) => {
    if (photoId !== undefined) {
      const running = Math.max(0, (runningRef.current.get(photoId) ?? 0) - 1);
      if (running > 0) runningRef.current.set(photoId, running);
      else {
        runningRef.current.delete(photoId);
        markLikeSaved(holdsRef.current, photoId);
        // A refresh may have confirmed the like while it was running; an
        // identical later response can keep the same photos array, so look
        // at the current one now.
        setLiked(likedFromPayload(photosRef.current, holdsRef.current));
      }
    }
    onFeedbackChange?.(photoId);
  }, [onFeedbackChange]);
  // A submit was refused (a finished selection): it counts as no longer
  // running, and once none is left for the photo the hold goes and the heart
  // shows the current payload, the server's truth, rather than toggling back
  // (a rollback toggle would count as one more submit that never settles).
  // The row is refreshed so that payload is current.
  const failed = useCallback((photoId: number) => {
    const running = Math.max(0, (runningRef.current.get(photoId) ?? 0) - 1);
    if (running > 0) {
      runningRef.current.set(photoId, running);
      return;
    }
    runningRef.current.delete(photoId);
    holdsRef.current.delete(photoId);
    setLiked(likedFromPayload(photosRef.current, holdsRef.current));
    onFeedbackChange?.(photoId);
  }, [onFeedbackChange]);
  return [liked, toggle, settled, failed];
}
