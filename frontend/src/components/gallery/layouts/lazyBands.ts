import { useMemo } from 'react';

/**
 * The two IntersectionObserver bands every lazy gallery layout hands to
 * PhotoCard: a tile starts loading inside the load band and is released
 * (unmounted) once it leaves the keep band (#1287, issue 1733).
 *
 * Both are meant in viewport heights — "one screen ahead, three screens
 * behind". They used to be written as `100% 0px` / `300% 0px`, but a
 * percentage in `rootMargin` resolves against the WIDTH of the root for every
 * side, top and bottom included (IntersectionObserver spec, rootMargin:
 * "Percentages are resolved relative to the width of the undilated
 * rectangle"). On a 390×844 phone that preloaded 390px and released after
 * 1170px — under half and one and a half screens — so fast vertical
 * scrolling showed skeletons and tiles were released far earlier than
 * documented. Pixels derived from the viewport height say what was meant.
 *
 * `rootMargin` accepts only px and % (a `vh` value throws at construction),
 * hence the conversion here rather than a unit in the string.
 */
export const LOAD_BAND_VIEWPORTS = 1;
export const KEEP_BAND_VIEWPORTS = 3;

export interface LazyBands {
  /** Start loading the tile inside this band (`inViewRootMargin`). */
  load: string;
  /** Release the tile once it leaves this band (`releaseRootMargin`). */
  keep: string;
}

export function lazyBands(viewportHeight: number): LazyBands {
  // A sane floor for jsdom and odd embeds that report 0.
  const height = Math.max(Math.round(viewportHeight) || 0, 400);
  return {
    load: `${height * LOAD_BAND_VIEWPORTS}px 0px`,
    keep: `${height * KEEP_BAND_VIEWPORTS}px 0px`,
  };
}

/**
 * Bands for the current viewport, fixed at mount. The observer is re-created
 * whenever its options change, so this deliberately does not track resizes:
 * an orientation change only shifts the bands by the aspect ratio, and the
 * hysteresis between them still holds.
 */
export function useLazyBands(): LazyBands {
  return useMemo(
    () => lazyBands(typeof window === 'undefined' ? 0 : window.innerHeight),
    [],
  );
}
