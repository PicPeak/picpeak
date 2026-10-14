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
import type { Photo } from '../../../types';

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
