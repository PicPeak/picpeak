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

/**
 * The box the original is drawn in: its own proportions, inside the box the
 * preview takes. The two only differ where the preview failed and a
 * cover-cropped thumbnail stands in for it.
 */
export function overlayBox(natural: Size, fit: Size): Size {
  const scale = Math.min(fit.width / natural.width, fit.height / natural.height);
  return { width: natural.width * scale, height: natural.height * scale };
}

/** Whether this device may decode the original at all. Unknown dimensions count as too large on touch. */
export function withinPixelBudget(natural: Size | null, coarsePointer: boolean): boolean {
  if (!coarsePointer) return true;
  return !!natural && natural.width * natural.height <= TOUCH_PIXEL_BUDGET;
}

const hasCoarsePointer = () => typeof window !== 'undefined'
  && typeof window.matchMedia === 'function'
  && window.matchMedia('(pointer: coarse)').matches;

const currentPixelRatio = () => (typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1);

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
  /** True while a drag or a pinch drives the transform. */
  gesturing: boolean;
  /** The element the lightbox measures the cursor against; its centre is the image's. */
  containerRef: RefObject<HTMLElement>;
}

interface LoadedOriginal extends Size { photoId: number; url: string; src: string }

export function useFullResolutionZoom({
  photo, slug, enabled, zoom, dragOffset, setZoom, setDragOffset, gesturing, containerRef,
}: Options) {
  const photoId = photo?.id;
  const stated = photo?.width && photo?.height ? { width: photo.width, height: photo.height } : null;
  const url = enabled && photo?.full_resolution_url && withinPixelBudget(stated, hasCoarsePointer())
    ? photo.full_resolution_url
    : null;

  const [loaded, setLoaded] = useState<LoadedOriginal | null>(null);
  const [requestedId, setRequestedId] = useState<number | null>(null);
  const [failedId, setFailedId] = useState<number | null>(null);
  // The object URL whose <img> has loaded in the document, not just decoded off screen.
  const [paintedSrc, setPaintedSrc] = useState<string | null>(null);
  const [fit, setFit] = useState<Size | null>(null);
  const [pixelRatio, setPixelRatio] = useState(currentPixelRatio);
  // The object URL the effect below revokes; one handed to setLoaded only
  // gets there if that update is committed.
  const committedSrc = useRef<string | null>(null);
  const slideRef = useRef<HTMLDivElement | null>(null);
  // Also as state: the carousel can remount the slide under the same photo
  // (its keys change when the gallery goes to or from two photos), and the
  // listeners below have to move to the new element.
  const [slide, setSlide] = useState<HTMLDivElement | null>(null);
  const attachSlide = useCallback((el: HTMLDivElement | null) => {
    slideRef.current = el;
    setSlide(el);
    // A new slide brings a new overlay element, which has painted nothing yet.
    setPaintedSrc(null);
  }, []);
  // For handlers the lightbox registers once (wheel) or that fire between
  // renders, and for the load that ends after the render that started it.
  const live = useRef({ zoom, dragOffset, actualZoom: null as number | null, maxZoom: BASE_MAX_ZOOM });

  // State of another photo is never shown, nor an original the server no
  // longer offers: the reset below lands one render after the change.
  const original = loaded && loaded.photoId === photoId && loaded.url === url ? loaded : null;
  const requested = requestedId !== null && requestedId === photoId;

  // The preview's layout box (untransformed). The overlay is fitted into this
  // box, and the ceiling is the original's pixels over it.
  const measure = useCallback(() => {
    const el = slideRef.current?.querySelector<HTMLElement>('img:not([data-full-resolution])');
    const next = el && el.offsetWidth > 0 && el.offsetHeight > 0
      ? { width: el.offsetWidth, height: el.offsetHeight }
      : null;
    setFit((prev) => (prev?.width === next?.width && prev?.height === next?.height ? prev : next));
    // Also here: a browser whose media query cannot notify still resizes.
    setPixelRatio(currentPixelRatio());
  }, []);

  useEffect(() => {
    if (!url) {
      setFit(null);
      return;
    }
    measure();
    const el = slide;
    if (!el) return;
    // `load` does not bubble, so it is captured: the thumbnail that stands in
    // for an undecodable preview loads without telling onPreviewLoad.
    el.addEventListener('load', measure, true);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(el);
    return () => {
      el.removeEventListener('load', measure, true);
      observer?.disconnect();
    };
  }, [url, photoId, slide, measure]);

  // 100 % is counted in device pixels, and the window can move to a display
  // with another density without its layout changing at all.
  useEffect(() => {
    if (!url || typeof window.matchMedia !== 'function') return;
    setPixelRatio(currentPixelRatio());
    const query = window.matchMedia(`(resolution: ${pixelRatio}dppx)`);
    const update = () => setPixelRatio(currentPixelRatio());
    query.addEventListener?.('change', update);
    return () => query.removeEventListener?.('change', update);
  }, [url, pixelRatio]);

  // Navigating away releases the original, and so does a refreshed photo list
  // that withdraws the offer or points it elsewhere. Its object URL goes in
  // the effect after this one.
  useEffect(() => {
    setLoaded(null);
    setRequestedId(null);
    setFailedId(null);
    setPaintedSrc(null);
  }, [photoId, url]);

  useEffect(() => {
    committedSrc.current = loaded?.src ?? null;
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
    let decoder: HTMLImageElement | null = null;
    let handedOver = false;
    let handedSrc: string | null = null;

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
        decoder = image;
        image.src = objectUrl;
        // Decoded before it is shown, so the swap is a repaint and not a
        // blank frame while a 40 MP JPEG decodes.
        await image.decode();
        if (cancelled) return;
        handedOver = true;
        handedSrc = objectUrl;
        setLoaded({ photoId, url, src: objectUrl, width: image.naturalWidth, height: image.naturalHeight });
      } catch {
        // Refused, aborted, or not decodable: the preview stays, silently.
        if (cancelled) return;
        // The ceiling falls back to the old one with it; the clamp below
        // brings back a zoom already past that.
        setFailedId(photoId);
      } finally {
        if (objectUrl && !handedOver) URL.revokeObjectURL(objectUrl);
        objectUrl = null;
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
      // A decode still running is given up now, not when it settles: paging
      // quickly through large photos would otherwise stack full-size decodes.
      if (!handedOver) {
        decoder?.removeAttribute('src');
        if (objectUrl) URL.revokeObjectURL(objectUrl);
        objectUrl = null;
      } else if (handedSrc && committedSrc.current !== handedSrc) {
        // Unmounted between the hand-over and its commit: nobody else has it.
        URL.revokeObjectURL(handedSrc);
      }
    };
  }, [url, requested, photoId, slug]);

  const failed = failedId !== null && failedId === photoId;
  // What was decoded wins over what the list stated.
  const decoded = original && original.width > 0 && original.height > 0 ? original : null;
  const natural = decoded ?? stated;
  const box = decoded && fit ? overlayBox(decoded, fit) : null;
  const actualZoom = url && !failed && natural && fit
    ? actualPixelsZoom(natural, box ?? fit, pixelRatio)
    : null;
  // While the ceiling is merely unknown (the preview is between two loads and
  // has no box), the zoom holds where it is: no further in, and not forced out.
  const ceilingKnown = !url || failed || actualZoom !== null;
  const maxZoom = ceilingKnown ? maxZoomFor(actualZoom) : Math.max(BASE_MAX_ZOOM, zoom);
  live.current = { zoom, dragOffset, actualZoom, maxZoom };

  // The ceiling can come down under a zoom already past it: the window grew,
  // the decoded original is smaller than the list stated, or the load failed.
  // The zoom follows, about the point at the centre of the view. A drag or a
  // pinch is left to finish first: each holds a baseline taken at its start
  // and would put the old zoom or offset straight back.
  useEffect(() => {
    if (gesturing || zoom <= maxZoom) return;
    const ratio = maxZoom / zoom;
    const offset = live.current.dragOffset;
    setZoom(maxZoom);
    setDragOffset({ x: offset.x * ratio, y: offset.y * ratio });
  }, [gesturing, zoom, maxZoom, setZoom, setDragOffset]);

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
    slideRef: attachSlide,
    /** Pass to the slide's image: the preview's box is only known once it has loaded. */
    onPreviewLoad: measure,
    overlay: original && fit
      ? { src: original.src, ...(box ?? fit), onLoad: () => setPaintedSrc(original.src) }
      : null,
    /**
     * True once the original is on screen. The preview then gives up its
     * pixels (not its box or its pointer events): drawn under the original it
     * would show through every transparent pixel a second time.
     */
    previewHidden: !!original && !!fit && paintedSrc === original.src,
    onDoubleClick,
    onTouchStart,
    onTouchEnd,
  };
}

export type FullResolutionZoom = ReturnType<typeof useFullResolutionZoom>;

/**
 * The decoded original, laid over the preview it replaces. A sibling of the
 * preview inside the slide (which must be `relative`), centred on the
 * preview's box under the same transform style, so the swap moves nothing.
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
      onLoad={overlay.onLoad}
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
