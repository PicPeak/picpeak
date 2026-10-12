import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type { Photo } from '../../../types';
import { buildResourceUrl } from '../../../utils/url';
import { withImageFetchSlot } from '../../../utils/imageFetchQueue';
import { getGalleryToken } from '../../../utils/galleryAuthStorage';

/**
 * Zoom to original pixels in the lightbox (issue 1733).
 *
 * The lightbox shows the preview tier and used to stop at 3x of fit. Where the
 * server says the viewer may have the original (`photo.full_resolution_url`,
 * which the photo route decides again on every request), zooming past fit
 * loads it, decodes it off screen and lays it over the preview under the same
 * transform. The ceiling then becomes the original's own pixels.
 *
 * 100 % means one image pixel per DEVICE pixel: the point past which zooming
 * only enlarges pixels. On a 2x display that is half the CSS-pixel figure.
 *
 * Without the URL every value here is the old behaviour: a ceiling of 3, no
 * request, no readout change, and the double-click and tap handlers decline.
 */

/** The ceiling of a photo with no full resolution, as a multiple of fit. */
export const BASE_MAX_ZOOM = 3;

/**
 * Largest original a touch device is asked to decode. A decoded image takes
 * four bytes per pixel whatever the file weighs, and iOS kills the tab well
 * before a desktop browser would complain.
 */
export const TOUCH_PIXEL_BUDGET = 50_000_000;

const DOUBLE_TAP_MS = 300;
const TAP_SLOP_PX = 10;
const DOUBLE_TAP_SLOP_PX = 30;

interface Size { width: number; height: number }
type Point = { x: number; y: number };

const longEdge = (size: Size) => Math.max(size.width, size.height);

/** The zoom factor, as a multiple of fit, at which one image pixel covers one device pixel. */
export function actualPixelsZoom(natural: Size, fit: Size, devicePixelRatio: number): number | null {
  const shown = longEdge(fit) * (devicePixelRatio || 1);
  return shown > 0 && longEdge(natural) > 0 ? longEdge(natural) / shown : null;
}

/** Never below the old ceiling: a small original still zooms to 3x of fit. */
export function maxZoomFor(actualZoom: number | null): number {
  return Math.max(BASE_MAX_ZOOM, actualZoom ?? 0);
}

/** Whether this device may decode the original at all. Unknown dimensions count as too large on touch. */
export function withinPixelBudget(natural: Size | null, coarsePointer: boolean): boolean {
  if (!coarsePointer) return true;
  return !!natural && natural.width * natural.height <= TOUCH_PIXEL_BUDGET;
}

const hasCoarsePointer = () => typeof window !== 'undefined'
  && typeof window.matchMedia === 'function'
  && window.matchMedia('(pointer: coarse)').matches;

interface Options {
  /** The photo on screen. */
  photo: Photo | undefined;
  slug: string;
  /** False where the slide is not a plain image: a video, or the canvas rendering mode. */
  enabled: boolean;
  zoom: number;
  dragOffset: Point;
  setZoom: (zoom: number) => void;
  setDragOffset: (offset: Point) => void;
  /** The element the lightbox measures the cursor against; its centre is the image's. */
  containerRef: RefObject<HTMLElement>;
}

interface LoadedOriginal extends Size { photoId: number; src: string }

export function useFullResolutionZoom({
  photo, slug, enabled, zoom, dragOffset, setZoom, setDragOffset, containerRef,
}: Options) {
  const photoId = photo?.id;
  const stated = photo?.width && photo?.height ? { width: photo.width, height: photo.height } : null;
  const url = enabled && photo?.full_resolution_url && withinPixelBudget(stated, hasCoarsePointer())
    ? photo.full_resolution_url
    : null;

  const [loaded, setLoaded] = useState<LoadedOriginal | null>(null);
  const [requestedId, setRequestedId] = useState<number | null>(null);
  const [failedId, setFailedId] = useState<number | null>(null);
  const [fit, setFit] = useState<Size | null>(null);
  const slideRef = useRef<HTMLDivElement | null>(null);
  // For handlers the lightbox registers once (wheel) or that fire between
  // renders, and for the load that ends after the render that started it.
  const live = useRef({ zoom, dragOffset, actualZoom: null as number | null, maxZoom: BASE_MAX_ZOOM });

  // State of another photo is never shown: the reset below lands one render
  // after the navigation.
  const original = loaded && loaded.photoId === photoId ? loaded : null;
  const requested = requestedId !== null && requestedId === photoId;

  // The preview's layout box (untransformed). The overlay takes exactly this
  // box, and the ceiling is the original's pixels over it.
  const measure = useCallback(() => {
    const el = slideRef.current?.querySelector<HTMLElement>('img:not([data-full-resolution])');
    const next = el && el.offsetWidth > 0 && el.offsetHeight > 0
      ? { width: el.offsetWidth, height: el.offsetHeight }
      : null;
    setFit((prev) => (prev?.width === next?.width && prev?.height === next?.height ? prev : next));
  }, []);

  useEffect(() => {
    if (!url) {
      setFit(null);
      return;
    }
    measure();
    const el = slideRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [url, photoId, measure]);

  // Navigating away releases the original. Its object URL goes in the effect
  // after this one.
  useEffect(() => {
    setLoaded(null);
    setRequestedId(null);
    setFailedId(null);
  }, [photoId]);

  useEffect(() => {
    if (!loaded) return;
    return () => URL.revokeObjectURL(loaded.src);
  }, [loaded]);

  // Latched on the first step past fit, so zooming back out mid-load does not
  // throw the request away.
  useEffect(() => {
    if (url && zoom > 1 && photoId !== undefined && failedId !== photoId) setRequestedId(photoId);
  }, [url, zoom, photoId, failedId]);

  useEffect(() => {
    if (!url || !requested || photoId === undefined) return;
    const controller = new AbortController();
    let cancelled = false;
    let objectUrl: string | null = null;
    let handedOver = false;

    (async () => {
      try {
        // The same request AuthenticatedImage makes: the gallery's bearer
        // token, the session cookie, and a slot in the shared fetch queue.
        const token = getGalleryToken(slug);
        const blob = await withImageFetchSlot(async () => {
          const response = await fetch(buildResourceUrl(url), {
            credentials: 'include',
            headers: token ? { Authorization: `Bearer ${token}` } : undefined,
            signal: controller.signal,
          });
          if (!response.ok) throw new Error(`Full resolution refused: ${response.status}`);
          return response.blob();
        }, { priority: 'high' });
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        const image = new Image();
        image.src = objectUrl;
        // Decoded before it is shown, so the swap is a repaint and not a
        // blank frame while a 40 MP JPEG decodes.
        await image.decode();
        if (cancelled) return;
        handedOver = true;
        setLoaded({ photoId, src: objectUrl, width: image.naturalWidth, height: image.naturalHeight });
      } catch {
        // Refused, aborted, or not decodable: the preview stays, silently.
        if (cancelled) return;
        setFailedId(photoId);
        // The ceiling falls back to the old one with it. A zoom already past
        // that comes back at once, about the point at the centre of the view.
        const { zoom: current, dragOffset: offset } = live.current;
        if (current > BASE_MAX_ZOOM) {
          const ratio = BASE_MAX_ZOOM / current;
          setZoom(BASE_MAX_ZOOM);
          setDragOffset({ x: offset.x * ratio, y: offset.y * ratio });
        }
      } finally {
        if (objectUrl && !handedOver) URL.revokeObjectURL(objectUrl);
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [url, requested, photoId, slug, setZoom, setDragOffset]);

  const failed = failedId !== null && failedId === photoId;
  // What was decoded wins over what the list stated.
  const natural = original && original.width > 0 && original.height > 0 ? original : stated;
  const actualZoom = url && !failed && natural && fit
    ? actualPixelsZoom(natural, fit, typeof window === 'undefined' ? 1 : window.devicePixelRatio)
    : null;
  const maxZoom = maxZoomFor(actualZoom);
  live.current = { zoom, dragOffset, actualZoom, maxZoom };

  // For handlers the lightbox registers once (wheel) or that fire between renders.

  const fitToScreen = useCallback(() => {
    setZoom(1);
    setDragOffset({ x: 0, y: 0 });
  }, [setZoom, setDragOffset]);

  /** From fit to 100 %, keeping the image point under (clientX, clientY) where it is. */
  const zoomToActualAt = useCallback((clientX: number, clientY: number) => {
    const { zoom: current, actualZoom: target } = live.current;
    const el = containerRef.current;
    if (!el || !target || target <= 1 || current > 1) return false;
    const rect = el.getBoundingClientRect();
    const cx = clientX - (rect.left + rect.width / 2);
    const cy = clientY - (rect.top + rect.height / 2);
    setZoom(target);
    setDragOffset({ x: cx * (1 - target), y: cy * (1 - target) });
    return true;
  }, [containerRef, setZoom, setDragOffset]);

  // Double tap. Browsers disagree on whether a touch double tap also fires
  // dblclick, so it is detected here and the dblclick that may follow is
  // swallowed.
  const tapStart = useRef<(Point & { t: number }) | null>(null);
  const lastTap = useRef<(Point & { t: number }) | null>(null);
  const swallowDoubleClickUntil = useRef(0);

  const onTouchStart = (e: React.TouchEvent) => {
    if (!url) return;
    if (e.touches.length === 1) {
      tapStart.current = { x: e.touches[0].clientX, y: e.touches[0].clientY, t: Date.now() };
    } else {
      tapStart.current = null;
      lastTap.current = null;
    }
  };

  const onTouchEnd = (e: React.TouchEvent) => {
    const start = tapStart.current;
    tapStart.current = null;
    if (!url || !start || e.touches.length > 0 || e.changedTouches.length === 0) return;
    const now = Date.now();
    const point = { x: e.changedTouches[0].clientX, y: e.changedTouches[0].clientY };
    if (Math.hypot(point.x - start.x, point.y - start.y) > TAP_SLOP_PX || now - start.t > DOUBLE_TAP_MS) {
      lastTap.current = null;
      return;
    }
    const previous = lastTap.current;
    if (previous && now - previous.t <= DOUBLE_TAP_MS
        && Math.hypot(point.x - previous.x, point.y - previous.y) <= DOUBLE_TAP_SLOP_PX) {
      lastTap.current = null;
      swallowDoubleClickUntil.current = now + 2 * DOUBLE_TAP_MS;
      if (!zoomToActualAt(point.x, point.y)) fitToScreen();
      return;
    }
    lastTap.current = { ...point, t: now };
  };

  /** True when the double-click was dealt with here; false leaves it to the lightbox. */
  const onDoubleClick = (e: React.MouseEvent) => {
    if (!url) return false;
    if (Date.now() < swallowDoubleClickUntil.current) return true;
    return zoomToActualAt(e.clientX, e.clientY);
  };

  return {
    /** Ceiling for every zoom input, as a multiple of fit. 3 without a full resolution. */
    maxZoom,
    live,
    /** Zoom as a percentage of the original's pixels, or null where the readout stays relative to fit. */
    percent: actualZoom ? Math.round((zoom / actualZoom) * 100) : null,
    loading: !!url && requested && !original && !failed,
    slideRef,
    /** Pass to the slide's image: the preview's box is only known once it has loaded. */
    onPreviewLoad: measure,
    overlay: original && fit ? { src: original.src, ...fit } : null,
    onDoubleClick,
    onTouchStart,
    onTouchEnd,
  };
}

export type FullResolutionZoom = ReturnType<typeof useFullResolutionZoom>;

/**
 * The decoded original, laid over the preview it replaces. A sibling of the
 * preview inside the slide (which must be `relative`), given the preview's
 * own box and the same transform style, so the swap moves nothing.
 */
export const FullResolutionImage: React.FC<{
  overlay: FullResolutionZoom['overlay'];
  style: React.CSSProperties;
}> = ({ overlay, style }) => {
  if (!overlay) return null;
  return (
    <img
      data-full-resolution
      src={overlay.src}
      alt=""
      aria-hidden="true"
      draggable={false}
      // Clicks, drags and the context menu keep landing on the preview below.
      className="absolute max-w-none select-none pointer-events-none"
      style={{
        ...style,
        width: overlay.width,
        height: overlay.height,
        left: '50%',
        top: '50%',
        marginLeft: -overlay.width / 2,
        marginTop: -overlay.height / 2,
      }}
    />
  );
};
