import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { LightboxOrigin } from './hooks/useTileClickOrigin';

const OPEN_GROW_MS = 250;
const OPEN_GROW_EASING = 'cubic-bezier(0.2, 0, 0, 1)';
/** How long the loaded slide takes to fade in over the grown tile image. */
export const OPEN_FADE_MS = 200;

type Box = { left: number; top: number; width: number; height: number };

const prefersReducedMotion = () =>
  typeof window.matchMedia === 'function'
  && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// The photo's box on the stage, where the slide will show it: as large as
// fits, centred, like the slide's object-contain, but never past the long
// edge of the image the slide loads, which it shows at most at natural size
// (max-w-full max-h-full).
const fitBox = (stage: { width: number; height: number }, aspect: number, maxLongEdge: number | null): Box => {
  let width = Math.min(stage.width, stage.height * aspect);
  if (maxLongEdge) width = Math.min(width, aspect >= 1 ? maxLongEdge : maxLongEdge * aspect);
  const height = width / aspect;
  return { left: (stage.width - width) / 2, top: (stage.height - height) / 2, width, height };
};

// From the tile to `box` (both in viewport pixels). The tile shows its image
// with object-cover, often at another aspect, so the start is a uniform
// scale that covers the tile, clipped to the tile: no stretching on the way.
const growKeyframes = (tile: Box, box: Box): Keyframe[] => {
  const scale = Math.max(tile.width / box.width, tile.height / box.height);
  const left = tile.left + tile.width / 2 - (box.width * scale) / 2;
  const top = tile.top + tile.height / 2 - (box.height * scale) / 2;
  const inset = [
    tile.top - top,
    left + box.width * scale - (tile.left + tile.width),
    top + box.height * scale - (tile.top + tile.height),
    tile.left - left,
  ].map((px) => `${Math.max(0, px / scale)}px`).join(' ');
  return [
    { transform: `translate(${left - box.left}px, ${top - box.top}px) scale(${scale})`, clipPath: `inset(${inset})` },
    { transform: 'none', clipPath: 'inset(0px 0px 0px 0px)' },
  ];
};

/**
 * The opening photo, on screen at once (Pixieset-style): the grid tile's own
 * image, already decoded, grows from the tile to the photo's place in the
 * lightbox and stays there until the slide's image has loaded. The slide then
 * fades in over it (`onReveal`), and it goes once that is done (`onDone`).
 * With reduced motion there is no grow and no fade: it is simply there, and
 * gone when the slide has loaded.
 *
 * Positioned like the slides' stage and rendered before it, so the slide
 * paints on top. Sized from the photo's own aspect where the list has it: the
 * thumbnail can be a square crop (thumbnail_fit 'cover'), and the slide that
 * replaces it is the whole frame; the fade blends the two framings.
 */
export const LightboxOpenGrow: React.FC<{
  origin: LightboxOrigin;
  aspect: number | null;
  /** Long edge of the image the slide loads, when known (lightboxImageLongEdge). */
  maxLongEdge: number | null;
  stageStyle: React.CSSProperties;
  /** The slide's image has loaded. */
  loaded: boolean;
  onReveal: () => void;
  onDone: () => void;
  onError: () => void;
}> = ({ origin, aspect, maxLongEdge, stageStyle, loaded, onReveal, onDone, onError }) => {
  const stageRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const [stage, setStage] = useState<{ width: number; height: number } | null>(null);

  // Before the first paint. The lightbox mounts this only once its toolbar
  // has been measured, so the stage already has its final size here.
  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const measure = () => setStage({ width: el.clientWidth, height: el.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const box = stage && stage.width > 0 && stage.height > 0
    ? fitBox(stage, aspect ?? origin.rect.width / origin.rect.height, maxLongEdge)
    : null;

  // Once, on the first measurement; a later resize only moves the end point.
  const grownRef = useRef(false);
  // When the grow ends, so a slide that loads mid-grow waits for it.
  const grownAtRef = useRef(0);
  const reducedMotionRef = useRef(false);
  useLayoutEffect(() => {
    const image = imageRef.current;
    const stageEl = stageRef.current;
    if (!box || !image || !stageEl || grownRef.current) return;
    grownRef.current = true;
    reducedMotionRef.current = prefersReducedMotion();
    if (reducedMotionRef.current || typeof image.animate !== 'function') return;
    grownAtRef.current = performance.now() + OPEN_GROW_MS;
    const { left, top } = stageEl.getBoundingClientRect();
    image.animate(
      growKeyframes(origin.rect, { ...box, left: left + box.left, top: top + box.top }),
      { duration: OPEN_GROW_MS, easing: OPEN_GROW_EASING },
    );
  }, [box, origin.rect]);

  // Through refs: the lightbox hands over fresh inline callbacks each render.
  const onRevealRef = useRef(onReveal);
  onRevealRef.current = onReveal;
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;
  useEffect(() => {
    if (!loaded) return;
    if (reducedMotionRef.current) {
      onDoneRef.current();
      return;
    }
    const growLeft = Math.max(0, grownAtRef.current - performance.now());
    const reveal = window.setTimeout(() => onRevealRef.current(), growLeft);
    const done = window.setTimeout(() => onDoneRef.current(), growLeft + OPEN_FADE_MS);
    return () => {
      window.clearTimeout(reveal);
      window.clearTimeout(done);
    };
  }, [loaded]);

  return (
    <div ref={stageRef} className="absolute top-0 left-0 z-0 pointer-events-none" style={stageStyle}>
      <img
        ref={imageRef}
        src={origin.src}
        // A stand-in for the slide, which carries the photo's name.
        alt=""
        aria-hidden="true"
        data-testid="lightbox-open-grow"
        className="absolute object-cover select-none"
        style={box
          ? { left: box.left, top: box.top, width: box.width, height: box.height, transformOrigin: '0 0' }
          : { visibility: 'hidden' }}
        draggable={false}
        onError={onError}
      />
    </div>
  );
};
