/**
 * Hold-to-scrub for the lightbox (issue 1733, backlog item B5).
 *
 * Holding an arrow key used to step once per OS key repeat, about thirty
 * times a second, and every step requested a preview and sent a view beacon
 * for a photo nobody looked at. While a key repeats, this hook steps at a
 * fixed rate and reports `scrubbing`, which the lightbox reads to show the
 * thumbnail instead of the preview and to hold back the beacon, the `?photo=`
 * update and the per-photo feedback request until the key is let go.
 *
 * A single press never reaches this hook's stepping: `handleKeyDown` only
 * claims events with `repeat` set.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

/** One step per interval while a key is held: about nine photos a second. */
export const SCRUB_STEP_INTERVAL_MS = 110;

/**
 * Safety net for a keyup that never arrives. Releasing is the keyup's job
 * (and the window's blur); this only ends a scrub whose key went up somewhere
 * the page could not see. Longer than the slowest OS repeat rate (Windows:
 * 400 ms), so a slow repeat is not mistaken for a release between two steps.
 */
export const SCRUB_IDLE_RELEASE_MS = 500;

type Direction = -1 | 1;

const directionOf = (key: string): Direction | null => {
  if (key === 'ArrowLeft') return -1;
  if (key === 'ArrowRight') return 1;
  return null;
};

export function useLightboxScrub(
  step: (direction: Direction) => void,
  currentPhotoId: number | undefined,
) {
  const [scrubbing, setScrubbing] = useState(false);
  // The photo the scrub ended on, until its preview has loaded: the thumbnail
  // stays underneath meanwhile, so letting go does not flash black.
  const [heldPhotoId, setHeldPhotoId] = useState<number | null>(null);

  const stepRef = useRef(step);
  stepRef.current = step;
  const currentPhotoIdRef = useRef(currentPhotoId);
  currentPhotoIdRef.current = currentPhotoId;
  const scrubbingRef = useRef(false);
  const lastStepAtRef = useRef(0);
  const idleTimerRef = useRef<number | undefined>(undefined);

  const release = useCallback(() => {
    window.clearTimeout(idleTimerRef.current);
    if (!scrubbingRef.current) return;
    scrubbingRef.current = false;
    setHeldPhotoId(currentPhotoIdRef.current ?? null);
    setScrubbing(false);
  }, []);

  /** True when the event was a repeat this hook handled; the caller stops there. */
  const handleKeyDown = useCallback((e: KeyboardEvent): boolean => {
    const direction = directionOf(e.key);
    if (direction === null || !e.repeat) return false;
    scrubbingRef.current = true;
    setScrubbing(true);
    window.clearTimeout(idleTimerRef.current);
    idleTimerRef.current = window.setTimeout(release, SCRUB_IDLE_RELEASE_MS);
    const now = Date.now();
    if (now - lastStepAtRef.current >= SCRUB_STEP_INTERVAL_MS) {
      lastStepAtRef.current = now;
      stepRef.current(direction);
    }
    return true;
  }, [release]);

  useEffect(() => {
    const handleKeyUp = (e: KeyboardEvent) => {
      if (directionOf(e.key) !== null) release();
    };
    document.addEventListener('keyup', handleKeyUp);
    window.addEventListener('blur', release);
    return () => {
      document.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('blur', release);
      window.clearTimeout(idleTimerRef.current);
    };
  }, [release]);

  const handlePreviewLoaded = useCallback(() => setHeldPhotoId(null), []);

  return {
    scrubbing,
    /** Show the thumbnail stand-in: mid-scrub, or until the landed preview is in. */
    standIn: scrubbing || (heldPhotoId !== null && heldPhotoId === currentPhotoId),
    handleKeyDown,
    handlePreviewLoaded,
  };
}
