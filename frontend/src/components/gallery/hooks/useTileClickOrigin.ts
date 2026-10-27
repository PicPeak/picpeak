/**
 * The grid tile a photo was opened from, for the lightbox to grow out of.
 *
 * Every layout calls `onPhotoClick(index)` without the event, and threading
 * one through all of them would touch every layout for an animation. Instead
 * this listens for clicks on the document in the capture phase, before the
 * tile's own handler runs, and the opener reads the clicked tile back while
 * that same click is still being dispatched. A lightbox opened any other way
 * (a `?photo=` link, history back) finds nothing and opens without the grow.
 */
import { useCallback, useEffect, useRef } from 'react';

export interface LightboxOrigin {
  /** The tile's image as it is on screen: already fetched and decoded. */
  src: string;
  /** Where that image sits in the viewport. */
  rect: { left: number; top: number; width: number; height: number };
}

// The tile's image: the nearest element around the click that holds exactly
// one <img>. Two or more means the walk has left the tile for the grid, which
// happens for a tile without an image (a video without a poster).
const tileImageAt = (target: EventTarget | null): HTMLImageElement | null => {
  let node = target instanceof Element ? target : null;
  while (node && node !== document.body) {
    if (node instanceof HTMLImageElement) return node;
    const images = node.getElementsByTagName('img');
    if (images.length === 1) return images[0];
    if (images.length > 1) return null;
    node = node.parentElement;
  }
  return null;
};

export function useTileClickOrigin() {
  const clickRef = useRef<MouseEvent | null>(null);

  useEffect(() => {
    let clearTimer: number | undefined;
    const capture = (e: MouseEvent) => {
      clickRef.current = e;
      // Only for the click being dispatched: a handler that stops propagation
      // must not leave it behind for a lightbox opened later by other means.
      window.clearTimeout(clearTimer);
      clearTimer = window.setTimeout(() => { clickRef.current = null; });
    };
    document.addEventListener('click', capture, true);
    return () => {
      document.removeEventListener('click', capture, true);
      window.clearTimeout(clearTimer);
    };
  }, []);

  /** The clicked tile, when called from inside a tile's click handler. */
  return useCallback((): LightboxOrigin | null => {
    const click = clickRef.current;
    clickRef.current = null;
    const image = tileImageAt(click?.target ?? null);
    // Not loaded yet: nothing on screen to grow from.
    if (!click || !image || !image.complete || image.naturalWidth === 0) return null;
    const src = image.currentSrc || image.src;
    const { left, top, width, height } = image.getBoundingClientRect();
    if (!src || width === 0 || height === 0) return null;
    // A pointer click lands on the image it opens; one that does not found
    // some other picture on the way up. A keyboard click (detail 0) has no
    // position, and its target is the tile itself.
    const { clientX: x, clientY: y } = click;
    if (click.detail > 0 && (x < left || x > left + width || y < top || y > top + height)) return null;
    return { src, rect: { left, top, width, height } };
  }, []);
}
