import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AnnotationSvg } from './AnnotationSvg';
import {
  finishFreehand,
  type AnnotationPoint,
  type AnnotationStroke,
  type AnnotationTool,
} from '../../../utils/photoAnnotation';

interface ImageBox {
  width: number;
  height: number;
}

/**
 * The rectangle the picture actually covers inside `container`, whose direct
 * child is the <img> (or the protected <canvas>) and which centres it.
 *
 * Measured from the rendered element rather than from the photo's
 * width / height, which can be null. Layout sizes (offsetWidth) are used on
 * purpose: unlike getBoundingClientRect they ignore the zoom transform. The
 * element's box can be wider than the picture under object-fit: contain, so
 * the picture is fitted into it by its natural ratio.
 *
 * Null as well while the element shows its fallback (AuthenticatedImage marks
 * that with data-fallback): a thumbnail standing in for a picture that did
 * not load can be a centre crop, and coordinates relative to the whole
 * picture would land in the wrong place on it, drawn or shown.
 */
function measureImageBox(container: HTMLElement): ImageBox | null {
  const media = container.querySelector<HTMLImageElement | HTMLCanvasElement>(':scope > img, :scope > canvas');
  if (!media || media.dataset.fallback === 'true') return null;
  const naturalWidth = media instanceof HTMLImageElement ? media.naturalWidth : media.width;
  const naturalHeight = media instanceof HTMLImageElement ? media.naturalHeight : media.height;
  const boxWidth = media.offsetWidth;
  const boxHeight = media.offsetHeight;
  if (!naturalWidth || !naturalHeight || !boxWidth || !boxHeight) return null;
  const scale = Math.min(boxWidth / naturalWidth, boxHeight / naturalHeight);
  return { width: naturalWidth * scale, height: naturalHeight * scale };
}

interface ImageAnnotationOverlayProps {
  /** As the API returned it; AnnotationSvg validates it. */
  annotation: unknown;
  /**
   * Extra style for the SVG. The lightbox passes the image's own transform
   * and transition here: both boxes share a centre, so the drawing follows
   * the zoom and pan exactly.
   */
  svgStyle?: React.CSSProperties;
  lineWidth?: number;
  /** Present while the guest is drawing; absent for a read-only overlay. */
  draw?: {
    tool: AnnotationTool;
    color: number;
    onStroke: (stroke: AnnotationStroke) => void;
  };
  label?: string;
}

/**
 * Lays a drawn annotation over a picture (issue 1733). Render it as a child
 * of a positioned container that centres its direct-child image; the overlay
 * finds that image and sits on exactly the rectangle it covers, and follows
 * resizes, device rotation and the image finishing its load.
 */
export const ImageAnnotationOverlay: React.FC<ImageAnnotationOverlayProps> = ({
  annotation,
  svgStyle,
  lineWidth,
  draw,
  label,
}) => {
  const anchorRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<ImageBox | null>(null);

  useLayoutEffect(() => {
    const container = anchorRef.current?.parentElement;
    if (!container) return;
    const update = () => {
      const next = measureImageBox(container);
      setBox((prev) => (prev?.width === next?.width && prev?.height === next?.height ? prev : next));
    };
    const resizeObserver = new ResizeObserver(update);
    // The image element is swapped as it loads (placeholder, then <img> or
    // <canvas>), so the observed element is re-picked on every child change.
    const mutationObserver = new MutationObserver(() => observe());
    const observe = () => {
      resizeObserver.disconnect();
      resizeObserver.observe(container);
      const media = container.querySelector(':scope > img, :scope > canvas');
      if (media) {
        resizeObserver.observe(media);
        // The fallback mark can flip on an element that stays (a picture
        // that loaded but does not decode).
        mutationObserver.observe(media, { attributes: true, attributeFilter: ['data-fallback'] });
      }
      update();
    };
    observe();
    mutationObserver.observe(container, { childList: true });
    // `load` does not bubble; capture it for the natural size.
    container.addEventListener('load', update, true);
    return () => {
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      container.removeEventListener('load', update, true);
    };
  }, []);

  // The pointer trail of the stroke being drawn, in 0..1 image coordinates.
  const trailRef = useRef<AnnotationPoint[] | null>(null);
  // The pointer that started it: only that one's release ends the stroke.
  const strokePointerRef = useRef<number | null>(null);
  const [pending, setPending] = useState<AnnotationStroke | null>(null);

  // Drawing can end with the pointer still down (Escape mid-stroke). The
  // overlay may stay mounted for an attached drawing, and without `draw`
  // nothing handles the pointerup any more: drop the unfinished stroke here.
  const drawing = !!draw;
  useEffect(() => {
    if (drawing) return;
    trailRef.current = null;
    setPending(null);
  }, [drawing]);

  const toPoint = (e: React.PointerEvent<SVGSVGElement>): AnnotationPoint | null => {
    const rect = e.currentTarget.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    const clamp = (n: number) => Math.max(0, Math.min(1, n));
    return [clamp((e.clientX - rect.left) / rect.width), clamp((e.clientY - rect.top) / rect.height)];
  };

  const handlePointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!draw || !e.isPrimary || (e.pointerType === 'mouse' && e.button !== 0)) return;
    const point = toPoint(e);
    if (!point) return;
    e.preventDefault();
    // Keep the stroke when the pointer leaves the picture mid-line.
    e.currentTarget.setPointerCapture?.(e.pointerId);
    trailRef.current = [point];
    strokePointerRef.current = e.pointerId;
    setPending({ t: draw.tool, c: draw.color, p: [point, point] });
  };

  const handlePointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const trail = trailRef.current;
    if (!draw || !trail || !e.isPrimary) return;
    const point = toPoint(e);
    if (!point) return;
    if (draw.tool === 'arrow') {
      trail[1] = point;
    } else {
      trail.push(point);
    }
    setPending({ t: draw.tool, c: draw.color, p: [...trail] });
  };

  const endStroke = (e: React.PointerEvent<SVGSVGElement>, commit: boolean) => {
    // A second finger is ignored on the way down; lifting it must not end
    // the stroke the first one is still drawing.
    if (e.pointerId !== strokePointerRef.current) return;
    const trail = trailRef.current;
    trailRef.current = null;
    setPending(null);
    if (!draw || !trail || !commit) return;
    // finishFreehand clamps, rounds and drops a tap; an arrow is its two
    // end points put through the same rounding.
    const points = finishFreehand(draw.tool === 'arrow' ? trail.slice(0, 2) : trail);
    if (points) draw.onStroke({ t: draw.tool, c: draw.color, p: points });
  };

  return (
    // z-10: the lightbox image carries a transform, which makes it a stacking
    // context that would otherwise paint over the drawing.
    <div ref={anchorRef} className="absolute inset-0 z-10 pointer-events-none">
      {box && (
        <AnnotationSvg
          annotation={annotation}
          aspect={box.width / box.height}
          pending={pending}
          lineWidth={lineWidth}
          role="img"
          aria-label={label}
          data-testid="annotation-overlay"
          onPointerDown={draw ? handlePointerDown : undefined}
          onPointerMove={draw ? handlePointerMove : undefined}
          onPointerUp={draw ? (e) => endStroke(e, true) : undefined}
          onPointerCancel={draw ? (e) => endStroke(e, false) : undefined}
          style={{
            position: 'absolute',
            left: `calc(50% - ${box.width / 2}px)`,
            top: `calc(50% - ${box.height / 2}px)`,
            width: box.width,
            height: box.height,
            pointerEvents: draw ? 'auto' : 'none',
            // The browser must not turn a stroke into a scroll or a zoom.
            touchAction: draw ? 'none' : undefined,
            cursor: draw ? 'crosshair' : undefined,
            ...svgStyle,
          }}
        />
      )}
    </div>
  );
};
