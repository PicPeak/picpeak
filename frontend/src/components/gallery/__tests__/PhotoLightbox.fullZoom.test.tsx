/**
 * Zoom to original pixels in the lightbox (issue 1733).
 *
 *  - without `full_resolution_url` nothing changes: 3x ceiling, a readout
 *    relative to fit, no request, a double-click at fit does nothing
 *  - with it, zooming past fit fetches the original with the gallery token,
 *    keeps the preview until the decode is done, then lays the original over
 *    it under the same transform
 *  - the ceiling is the original's pixels over the rendered ones, and the
 *    readout counts against that
 *  - navigating away revokes the object URL; a refused load falls back silently
 *  - a touch device is not asked to decode an original over the pixel budget
 */
import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Photo } from '../../../types';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string, d?: unknown) => (typeof d === 'string' ? d : k) }) }));
vi.mock('../../../hooks/useDevToolsProtection', () => ({ useDevToolsProtection: () => undefined }));
vi.mock('../../../hooks/useGallery', () => ({ useSavePhotoToDevice: () => ({ mutate: vi.fn(), isPending: false }) }));
vi.mock('../../../hooks/useFeedbackLimitModal', () => ({ useFeedbackLimitModal: () => ({ modal: null, handleError: () => false }) }));
vi.mock('../../../contexts/GuestIdentityContext', () => ({ useGuestIdentityOptional: () => null }));
vi.mock('../../../services/feedback.service', () => ({
  feedbackService: {
    getGalleryFeedbackSettings: vi.fn().mockResolvedValue({ feedback_enabled: false }),
    getPhotoFeedback: vi.fn().mockResolvedValue(null),
  },
}));
vi.mock('../../../services/gallery.service', () => ({ galleryService: { trackPhotoView: vi.fn() } }));
vi.mock('../../../utils/galleryAuthStorage', async (original) => ({
  ...(await original<typeof import('../../../utils/galleryAuthStorage')>()),
  getGalleryToken: () => 'gallery-token',
}));
vi.mock('../../common', async () => {
  const { useEffect } = await import('react');
  return {
    AuthenticatedImage: ({ alt, style, onLoad }: {
      alt: string; style?: React.CSSProperties; onLoad?: (d: { width: number; height: number }) => void;
    }) => {
      useEffect(() => { onLoad?.({ width: 1920, height: 1280 }); }, [onLoad]);
      previewLoaded = () => onLoad?.({ width: 1920, height: 1280 });
      return <img alt={alt} style={style} />;
    },
  };
});

import { PhotoLightbox } from '../PhotoLightbox';

// The preview reporting a (new) load, as after a refetched photo list.
let previewLoaded: () => void = () => {};

// Records the observers so a test can report a resize of the slide. Like the
// real one, an observer says nothing about an element that left the document.
let resizeObservers: ResizeObserverStub[] = [];
class ResizeObserverStub {
  target: Element | null = null;
  constructor(public notify: () => void) { resizeObservers.push(this); }
  observe(target: Element) { this.target = target; }
  disconnect() { this.target = null; }
}
vi.stubGlobal('ResizeObserver', ResizeObserverStub);

// The preview is laid out 600x400; the original is 6000x4000. At a device
// pixel ratio of 1 that puts 100 % at 10x of fit.
let FIT = { width: 600, height: 400 };
const resizePreview = (next: typeof FIT) => {
  FIT = next;
  act(() => { resizeObservers.forEach((observer) => { if (observer.target?.isConnected) observer.notify(); }); });
};
const photo = (id: number, extra: Partial<Photo> = {}) => ({
  id, filename: `photo-${id}`, url: `/p/${id}`, thumbnail_url: `/t/${id}`, width: 6000, height: 4000, ...extra,
} as Photo);
const zoomable = (id: number, extra: Partial<Photo> = {}) =>
  photo(id, { full_resolution_url: `/api/gallery/g/photo/${id}?zoom=1`, ...extra });

const finger = (clientX: number, clientY = 300) => ({ clientX, clientY });

let decode: { resolve: () => void; reject: (e: Error) => void };
let fetchMock: ReturnType<typeof vi.fn>;
let createObjectURL: ReturnType<typeof vi.fn>;
let revokeObjectURL: ReturnType<typeof vi.fn>;
let coarse = false;
// What a `(resolution: …)` media query told its listeners: the window moved to another display.
let densityListeners: Array<() => void> = [];

beforeEach(() => {
  coarse = false;
  FIT = { width: 600, height: 400 };
  resizeObservers = [];
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get() { return this.tagName === 'IMG' ? FIT.width : 0; } });
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get() { return this.tagName === 'IMG' ? FIT.height : 0; } });
  Object.defineProperty(HTMLImageElement.prototype, 'naturalWidth', { configurable: true, get: () => 6000 });
  Object.defineProperty(HTMLImageElement.prototype, 'naturalHeight', { configurable: true, get: () => 4000 });
  HTMLImageElement.prototype.decode = vi.fn(() => new Promise<void>((resolve, reject) => { decode = { resolve, reject }; }));
  Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 1 });
  densityListeners = [];
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: coarse && query.includes('coarse'),
    addEventListener: (_: string, listener: () => void) => { if (query.includes('resolution')) densityListeners.push(listener); },
    removeEventListener: (_: string, listener: () => void) => { densityListeners = densityListeners.filter((l) => l !== listener); },
  }));
  fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, blob: async () => new Blob(['original']) });
  vi.stubGlobal('fetch', fetchMock);
  createObjectURL = vi.fn(() => 'blob:original');
  revokeObjectURL = vi.fn();
  URL.createObjectURL = createObjectURL as unknown as typeof URL.createObjectURL;
  URL.revokeObjectURL = revokeObjectURL as unknown as typeof URL.revokeObjectURL;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
});

const setup = (photos: Photo[], props: Partial<React.ComponentProps<typeof PhotoLightbox>> = {}) => {
  const onClose = vi.fn();
  const { container, rerender } = render(<PhotoLightbox photos={photos} initialIndex={1} onClose={onClose} slug="g" {...props} />);
  const update = (next: Photo[]) => rerender(<PhotoLightbox photos={next} initialIndex={1} onClose={onClose} slug="g" {...props} />);
  const image = () => screen.getByAltText(photos[1].filename);
  const surface = image().parentElement!.parentElement!.parentElement as HTMLElement;
  const overlay = () => container.querySelector<HTMLImageElement>('img[data-full-resolution]');
  const hint = () => screen.queryByTestId('lightbox-full-resolution-loading');
  const readout = () => screen.getByLabelText('Zoom in').previousElementSibling!.textContent;
  const pinch = (factor: number) => {
    fireEvent.touchStart(surface, { touches: [finger(100), finger(200)] });
    fireEvent.touchMove(surface, { touches: [finger(100), finger(100 + 100 * factor)] });
    fireEvent.touchEnd(surface, { touches: [], changedTouches: [finger(100)] });
  };
  return { container, image, surface, overlay, hint, readout, pinch, update };
};

// Lets the fetch, the blob read and the queue's microtasks settle.
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const finishDecode = async () => {
  await settle();
  await act(async () => { decode.resolve(); });
};

describe('PhotoLightbox without a full resolution', () => {
  it('keeps the 3x ceiling, the fit-relative readout and makes no request', async () => {
    const { image, readout, pinch, hint, overlay } = setup([photo(1), photo(2), photo(3)]);
    expect(readout()).toBe('100%');

    pinch(8);
    expect(image().style.transform).toContain('scale(3)');
    expect(readout()).toBe('300%');
    expect(screen.getByLabelText('Zoom in')).toBeDisabled();

    await settle();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(hint()).toBeNull();
    expect(overlay()).toBeNull();
  });

  it('does nothing on a double-click at fit and returns to fit from a zoom', () => {
    const { image, surface } = setup([photo(1), photo(2), photo(3)]);
    fireEvent.doubleClick(surface, { clientX: 10, clientY: 10 });
    expect(image().style.transform).toBe('scale(1) translate(0px, 0px)');

    fireEvent.click(screen.getByLabelText('Zoom in'));
    expect(image().style.transform).toContain('scale(1.5)');
    fireEvent.doubleClick(surface, { clientX: 10, clientY: 10 });
    expect(image().style.transform).toBe('scale(1) translate(0px, 0px)');
  });

  it('ignores the offer in canvas rendering mode', async () => {
    const { pinch, image } = setup([zoomable(1), zoomable(2), zoomable(3)], { useCanvasRendering: true });
    pinch(8);
    await settle();
    expect(image().style.transform).toContain('scale(3)');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('PhotoLightbox with a full resolution', () => {
  it('counts the readout against the original and lifts the ceiling to its pixels', () => {
    const { image, readout, pinch } = setup([zoomable(1), zoomable(2), zoomable(3)]);
    expect(readout()).toBe('10%');
    pinch(20);
    expect(image().style.transform).toContain('scale(10)');
    expect(readout()).toBe('100%');
    expect(screen.getByLabelText('Zoom in')).toBeDisabled();
  });

  it('halves the ceiling on a 2x display, never below 3x of fit', () => {
    Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 2 });
    const first = setup([zoomable(1), zoomable(2), zoomable(3)]);
    first.pinch(20);
    expect(first.image().style.transform).toContain('scale(5)');
  });

  it('follows the window to a display with another pixel density', () => {
    const { image, surface, readout } = setup([zoomable(1), zoomable(2), zoomable(3)]);
    fireEvent.doubleClick(surface, { clientX: 0, clientY: 0 });
    expect(image().style.transform).toContain('scale(10)');

    Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 2 });
    act(() => { densityListeners.forEach((notify) => notify()); });
    expect(image().style.transform).toContain('scale(5)');
    expect(readout()).toBe('100%');
  });

  it('picks a new pixel density up on a resize where the media query cannot notify', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: coarse && query.includes('coarse') }));
    const { image, surface } = setup([zoomable(1), zoomable(2), zoomable(3)]);
    fireEvent.doubleClick(surface, { clientX: 0, clientY: 0 });
    Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 2 });
    resizePreview(FIT);
    expect(image().style.transform).toContain('scale(5)');
  });

  it('keeps 3x of fit for a small original', () => {
    const small = { width: 900, height: 600 };
    const { image, readout, pinch } = setup([zoomable(1, small), zoomable(2, small), zoomable(3, small)]);
    Object.defineProperty(HTMLImageElement.prototype, 'naturalWidth', { configurable: true, get: () => 900 });
    Object.defineProperty(HTMLImageElement.prototype, 'naturalHeight', { configurable: true, get: () => 600 });
    pinch(20);
    expect(image().style.transform).toContain('scale(3)');
    expect(readout()).toBe('200%');
  });

  it('fetches past fit, keeps the preview until the decode is done, then swaps under the same transform', async () => {
    const { image, overlay, hint } = setup([zoomable(1), zoomable(2), zoomable(3)]);
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByLabelText('Zoom in'));
    expect(hint()).not.toBeNull();
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/api/gallery/g/photo/2?zoom=1');
    expect(init.headers).toEqual({ Authorization: 'Bearer gallery-token' });
    expect(init.credentials).toBe('include');

    // Fetched but not decoded yet: still the preview alone.
    expect(overlay()).toBeNull();
    expect(hint()).not.toBeNull();
    expect(image()).toBeInTheDocument();

    await act(async () => { decode.resolve(); });
    const full = overlay()!;
    expect(full.getAttribute('src')).toBe('blob:original');
    expect(full.style.transform).toBe(image().style.transform);
    expect(full.style.transition).toBe(image().style.transition);
    expect(full.style.width).toBe('600px');
    expect(full.style.height).toBe('400px');
    expect(image()).toBeInTheDocument();
    expect(hint()).toBeNull();

    // The two keep moving together.
    fireEvent.click(screen.getByLabelText('Zoom in'));
    expect(overlay()!.style.transform).toBe(image().style.transform);
    expect(image().style.transform).toContain('scale(2)');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('hides the preview once the original is painted, so transparent pixels are not drawn twice', async () => {
    const { image, overlay } = setup([zoomable(1), zoomable(2), zoomable(3)]);
    fireEvent.click(screen.getByLabelText('Zoom in'));
    await finishDecode();
    // In the document, not painted yet: the preview still shows.
    expect(image().style.opacity).toBe('');
    fireEvent.load(overlay()!);
    expect(image().style.opacity).toBe('0');
    // Still laid out and still the pointer target under the original.
    expect(image().style.visibility).toBe('');
    expect(image().style.transform).toBe(overlay()!.style.transform);

    fireEvent.keyDown(document, { key: 'ArrowRight' });
    expect(screen.getByAltText('photo-3').style.opacity).toBe('');
  });

  it('comes down with the ceiling when the window grows under a zoom at 100 %', async () => {
    const { image, surface, readout } = setup([zoomable(1), zoomable(2), zoomable(3)]);
    fireEvent.doubleClick(surface, { clientX: 20, clientY: -10 });
    expect(image().style.transform).toBe('scale(10) translate(-18px, 9px)');

    // A larger fit puts 100 % at 6x; the zoom follows it about the centre of the view.
    resizePreview({ width: 1000, height: 667 });
    expect(image().style.transform).toBe('scale(6) translate(-18px, 9px)');
    expect(readout()).toBe('100%');
    expect(screen.getByLabelText('Zoom in')).toBeDisabled();
  });

  it('leaves a zoom below the ceiling alone when the window grows', () => {
    const { image, readout } = setup([zoomable(1), zoomable(2), zoomable(3)]);
    fireEvent.click(screen.getByLabelText('Zoom in'));
    resizePreview({ width: 1000, height: 667 });
    expect(image().style.transform).toContain('scale(1.5)');
    expect(readout()).toBe('25%');
  });

  it('gives the original its own proportions over a square thumbnail fallback', async () => {
    // The preview failed and the cover-cropped thumbnail stands in for it.
    FIT = { width: 300, height: 300 };
    const { overlay, pinch, readout } = setup([zoomable(1), zoomable(2), zoomable(3)]);
    fireEvent.click(screen.getByLabelText('Zoom in'));
    await finishDecode();
    const full = overlay()!;
    expect(full.style.width).toBe('300px');
    expect(full.style.height).toBe('200px');
    expect(full.style.marginLeft).toBe('-150px');
    expect(full.style.marginTop).toBe('-100px');
    // 6000 original pixels over the 300 it is drawn at.
    pinch(40);
    expect(overlay()!.style.transform).toContain('scale(20)');
    expect(readout()).toBe('100%');
  });

  it('drops a loaded original when a refreshed list withdraws the offer', async () => {
    const { image, overlay, readout, update } = setup([zoomable(1), zoomable(2), zoomable(3)]);
    fireEvent.click(screen.getByLabelText('Zoom in'));
    await finishDecode();
    fireEvent.load(overlay()!);
    expect(image().style.opacity).toBe('0');

    // The same photos, as listed once a watermark was switched on.
    update([photo(1), photo(2), photo(3)]);
    expect(overlay()).toBeNull();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:original');
    // The preview loading again must not bring the original back.
    act(() => { previewLoaded(); });
    expect(overlay()).toBeNull();
    expect(image().style.opacity).toBe('');
    expect(readout()).toBe('150%');
  });

  it('measures an image that loads without reporting it, like the thumbnail after an undecodable preview', async () => {
    // Nothing measurable yet: the preview is still a placeholder.
    FIT = { width: 0, height: 0 };
    const { image, overlay, readout } = setup([zoomable(1), zoomable(2), zoomable(3)]);
    expect(readout()).toBe('100%');
    fireEvent.click(screen.getByLabelText('Zoom in'));
    await finishDecode();
    expect(overlay()).toBeNull();

    FIT = { width: 300, height: 300 };
    fireEvent.load(image());
    expect(overlay()).not.toBeNull();
    expect(overlay()!.style.width).toBe('300px');
    expect(overlay()!.style.height).toBe('200px');
  });

  it('keeps measuring the slide when the carousel remounts it under the same photo', async () => {
    const { overlay, update } = setup([zoomable(1), zoomable(2), zoomable(3)]);
    fireEvent.click(screen.getByLabelText('Zoom in'));
    await finishDecode();
    expect(overlay()!.style.width).toBe('600px');

    // Two photos left: the slides are keyed by slot now, so this is a new element.
    update([zoomable(1), zoomable(2)]);
    resizePreview({ width: 900, height: 600 });
    expect(overlay()!.style.width).toBe('900px');
  });

  it('waits for a drag to end before it brings the zoom down, so the drag keeps its baseline', () => {
    const { image, surface } = setup([zoomable(1), zoomable(2), zoomable(3)]);
    fireEvent.doubleClick(surface, { clientX: 0, clientY: 0 });
    fireEvent.mouseDown(surface, { clientX: 0, clientY: 0 });
    fireEvent.mouseMove(surface, { clientX: 100, clientY: 0 });
    expect(image().style.transform).toBe('scale(10) translate(10px, 0px)');

    resizePreview({ width: 1000, height: 667 });
    expect(image().style.transform).toBe('scale(10) translate(10px, 0px)');
    fireEvent.mouseUp(surface);
    expect(image().style.transform).toBe('scale(6) translate(10px, 0px)');
  });

  it('brings the zoom down after a pan the system cancelled', () => {
    const { image, surface } = setup([zoomable(1), zoomable(2), zoomable(3)]);
    fireEvent.doubleClick(surface, { clientX: 0, clientY: 0 });
    fireEvent.touchStart(surface, { touches: [finger(100)] });
    fireEvent.touchMove(surface, { touches: [finger(120)] });
    resizePreview({ width: 1000, height: 667 });
    expect(image().style.transform).toContain('scale(10)');
    fireEvent.touchCancel(surface, { touches: [] });
    expect(image().style.transform).toContain('scale(6)');
  });

  it('shows the preview again until the original is painted on a remounted slide', async () => {
    const { image, overlay, update } = setup([zoomable(1), zoomable(2), zoomable(3)]);
    fireEvent.click(screen.getByLabelText('Zoom in'));
    await finishDecode();
    fireEvent.load(overlay()!);
    expect(image().style.opacity).toBe('0');

    update([zoomable(1), zoomable(2)]);
    expect(overlay()).not.toBeNull();
    expect(image().style.opacity).toBe('');
    fireEvent.load(overlay()!);
    expect(image().style.opacity).toBe('0');
  });

  it('holds the zoom while the ceiling is unknown instead of dropping it to 3x', () => {
    const { image, surface } = setup([zoomable(1), zoomable(2), zoomable(3)]);
    fireEvent.doubleClick(surface, { clientX: 0, clientY: 0 });
    // The preview is a placeholder again (a retry): nothing to measure.
    resizePreview({ width: 0, height: 0 });
    fireEvent.wheel(surface, { deltaY: -100 });
    expect(image().style.transform).toContain('scale(10)');
    expect(screen.getByLabelText('Zoom in')).toBeDisabled();
  });

  it('keeps the right-click block on the zoomed original', async () => {
    const { image, surface, overlay } = setup([zoomable(1), zoomable(2), zoomable(3)], { disableRightClick: true });
    fireEvent.click(screen.getByLabelText('Zoom in'));
    await finishDecode();
    // The original takes no pointer events, so a right-click lands on the
    // preview below it; the lightbox blocks the menu for the whole document.
    expect(overlay()!.className).toContain('pointer-events-none');
    for (const target of [overlay()!, image(), surface]) {
      expect(fireEvent.contextMenu(target)).toBe(false);
    }
  });

  it('leaves the context menu alone without the right-click block', async () => {
    const { image, overlay } = setup([zoomable(1), zoomable(2), zoomable(3)]);
    fireEvent.click(screen.getByLabelText('Zoom in'));
    await finishDecode();
    expect(overlay()).not.toBeNull();
    expect(fireEvent.contextMenu(image())).toBe(true);
  });

  it('toggles between fit and 100 % at the cursor on double-click', () => {
    const { image, surface, readout } = setup([zoomable(1), zoomable(2), zoomable(3)]);
    // jsdom's rect is all zeros, so the container centre is the origin.
    fireEvent.doubleClick(surface, { clientX: 20, clientY: -10 });
    // offset = c * (1 - 10); the transform divides it by the zoom.
    expect(image().style.transform).toBe('scale(10) translate(-18px, 9px)');
    expect(readout()).toBe('100%');

    fireEvent.doubleClick(surface, { clientX: 20, clientY: -10 });
    expect(image().style.transform).toBe('scale(1) translate(0px, 0px)');
  });

  it('toggles on a double tap and swallows the double-click that follows it', () => {
    const { image, surface } = setup([zoomable(1), zoomable(2), zoomable(3)]);
    const tap = () => {
      fireEvent.touchStart(surface, { touches: [finger(20, -10)] });
      fireEvent.touchEnd(surface, { touches: [], changedTouches: [finger(20, -10)] });
    };
    tap();
    expect(image().style.transform).toBe('scale(1) translate(0px, 0px)');
    tap();
    expect(image().style.transform).toBe('scale(10) translate(-18px, 9px)');
    fireEvent.doubleClick(surface, { clientX: 20, clientY: -10 });
    expect(image().style.transform).toBe('scale(10) translate(-18px, 9px)');
  });

  it('releases the original when the viewer moves to another photo', async () => {
    const { overlay } = setup([zoomable(1), zoomable(2), zoomable(3)]);
    fireEvent.click(screen.getByLabelText('Zoom in'));
    await finishDecode();
    expect(overlay()).not.toBeNull();
    expect(revokeObjectURL).not.toHaveBeenCalled();

    fireEvent.keyDown(document, { key: 'ArrowRight' });
    expect(overlay()).toBeNull();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:original');
  });

  it('aborts a load the viewer navigates away from and never shows it', async () => {
    const { overlay } = setup([zoomable(1), zoomable(2), zoomable(3)]);
    fireEvent.click(screen.getByLabelText('Zoom in'));
    await settle();
    const { signal } = fetchMock.mock.calls[0][1];
    fireEvent.keyDown(document, { key: 'ArrowRight' });
    expect(signal.aborted).toBe(true);
    // The decode is still pending: its image and its object URL go now, not when it settles.
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:original');
    await act(async () => { decode.resolve(); });
    expect(overlay()).toBeNull();
    expect(revokeObjectURL).toHaveBeenCalledTimes(1);
  });

  it('falls back silently when the server refuses', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 403, blob: async () => new Blob() });
    const { image, overlay, hint, readout } = setup([zoomable(1), zoomable(2), zoomable(3)]);
    fireEvent.click(screen.getByLabelText('Zoom in'));
    await settle();
    expect(overlay()).toBeNull();
    expect(hint()).toBeNull();
    expect(createObjectURL).not.toHaveBeenCalled();
    // Back to the old behaviour for this photo.
    expect(image().style.transform).toContain('scale(1.5)');
    expect(readout()).toBe('150%');
    fireEvent.click(screen.getByLabelText('Zoom out'));
    await settle();
    fireEvent.click(screen.getByLabelText('Zoom in'));
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('comes back to the old 3x ceiling at once when a load fails past it', async () => {
    let refuse: (r: unknown) => void = () => {};
    fetchMock.mockReturnValue(new Promise((resolve) => { refuse = resolve; }));
    const { image, surface, readout } = setup([zoomable(1), zoomable(2), zoomable(3)]);
    fireEvent.doubleClick(surface, { clientX: 20, clientY: -10 });
    expect(image().style.transform).toBe('scale(10) translate(-18px, 9px)');
    await settle();
    await act(async () => { refuse({ ok: false, status: 403, blob: async () => new Blob() }); });
    await settle();
    // offset (-180, 90) scaled by 3/10, then divided by the zoom of 3.
    expect(image().style.transform).toBe('scale(3) translate(-18px, 9px)');
    expect(readout()).toBe('300%');
    expect(screen.getByLabelText('Zoom in')).toBeDisabled();
  });

  it('falls back silently when the original does not decode', async () => {
    const { overlay, hint } = setup([zoomable(1), zoomable(2), zoomable(3)]);
    fireEvent.click(screen.getByLabelText('Zoom in'));
    await settle();
    await act(async () => { decode.reject(new Error('EncodingError')); });
    expect(overlay()).toBeNull();
    expect(hint()).toBeNull();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:original');
  });

  it('does not load an original over the pixel budget on a touch device', async () => {
    coarse = true;
    const huge = { width: 9000, height: 6000 };
    const { image, readout, pinch } = setup([zoomable(1, huge), zoomable(2, huge), zoomable(3, huge)]);
    expect(readout()).toBe('100%');
    pinch(8);
    await settle();
    expect(image().style.transform).toContain('scale(3)');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('loads one within the budget on a touch device', async () => {
    coarse = true;
    const { pinch } = setup([zoomable(1), zoomable(2), zoomable(3)]);
    pinch(2);
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
