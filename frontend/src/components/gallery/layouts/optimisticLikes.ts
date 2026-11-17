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

export type LikeHolds = Map<number, { liked: boolean; savedAt?: number }>;

/** Hold `liked` for this photo until a payload confirms it. */
export function holdLike(holds: LikeHolds, photoId: number, liked: boolean) {
  holds.set(photoId, { liked });
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
  });
  photos.forEach((photo) => {
    if (holds.get(photo.id)?.liked === !!photo.is_liked) holds.delete(photo.id);
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
 * meant. Here the set follows each payload, and a toggle holds its state for
 * the confirmation window from the click, as these tiles do not report when
 * their submit succeeded.
 */
export function useViewerLikes(photos: Photo[]): [Set<number>, (photoId: number) => void] {
  const holdsRef = useRef<LikeHolds>(new Map());
  const [liked, setLiked] = useState<Set<number>>(() => likedFromPayload(photos, holdsRef.current));
  const photosRef = useRef(photos);
  photosRef.current = photos;
  useEffect(() => {
    setLiked(likedFromPayload(photos, holdsRef.current));
  }, [photos]);
  // All own likes were taken back: a held click is no longer what the server
  // holds, and the refresh that follows must show through.
  useEffect(() => {
    const onCleared = () => {
      holdsRef.current.clear();
      setLiked(likedFromPayload(photosRef.current, holdsRef.current));
    };
    window.addEventListener(LIKES_CLEARED_EVENT, onCleared);
    return () => window.removeEventListener(LIKES_CLEARED_EVENT, onCleared);
  }, []);
  const toggle = useCallback((photoId: number) => setLiked((previous) => {
    const next = new Set(previous);
    const nowLiked = !next.has(photoId);
    if (nowLiked) next.add(photoId);
    else next.delete(photoId);
    holdLike(holdsRef.current, photoId, nowLiked);
    markLikeSaved(holdsRef.current, photoId);
    return next;
  }), []);
  return [liked, toggle];
}
