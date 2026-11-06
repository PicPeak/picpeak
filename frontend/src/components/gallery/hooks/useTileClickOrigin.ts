/**
 * The grid tile a photo was opened from, for the lightbox to grow out of.
 *
 * The layouts of the grid call `onPhotoClick(index)` without the event, and
 * threading one through all of them would touch each for an animation. Instead
 * this listens for clicks on the document in the capture phase, before the
 * tile's own handler runs, and the opener reads the clicked tile back while
 * that same click is still being dispatched. A lightbox opened any other way
 * (a `?photo=` link, history back) finds nothing and opens without the grow.
 */
import { useCallback, useEffect, useRef } from 'react';
import { GRID_TILE_ATTR } from '../layouts/gridWindow';

export interface LightboxOrigin {
  /** The tile's image as it is on screen: already fetched and decoded. */
  src: string;
  /** Where that image sits in the viewport. */
  rect: { left: number; top: number; width: number; height: number };
}

// The tile's image: the first <img> of the photo tile around the click, the
// photo itself (badges and overlays come after it). Outside a tile, or in one
// without an image (a video without a poster, a canvas), there is none.
const tileImageAt = (target: EventTarget | null): HTMLImageElement | null => {
  const tile = target instanceof Element ? target.closest(`[${GRID_TILE_ATTR}]`) : null;
  return tile?.querySelector('img') ?? null;
};

// Where an image's pixels are inside its box. object-cover fills the box; an
// object-contain one (the Carousel's) leaves bars, and the grow must start
// from the photo, not from them.
const paintedRect = (image: HTMLImageElement, box: LightboxOrigin['rect']): LightboxOrigin['rect'] => {
  if (getComputedStyle(image).objectFit !== 'contain') return box;
  const scale = Math.min(box.width / image.naturalWidth, box.height / image.naturalHeight);
  const width = image.naturalWidth * scale;
  const height = image.naturalHeight * scale;
  return {
    left: box.left + (box.width - width) / 2,
    top: box.top + (box.height - height) / 2,
    width,
    height,
  };
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
    return { src, rect: paintedRect(image, { left, top, width, height }) };
  }, []);
}
