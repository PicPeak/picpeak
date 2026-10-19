/**
 * Retry after a failed fetch (#1287).
 *
 * A rejected fetch used to set `error`, render nothing, and never ask again:
 * the fetch effect only re-runs when its inputs change, and for a grid tile
 * they never do. A transient failure — a hiccup on cellular, Safari
 * cancelling loads when the tab is backgrounded — was therefore a
 * permanently blank tile with nothing in any log.
 *
 * The retry is bounded (three attempts, doubling delay) and gated on the
 * placeholder being on screen and the document being visible.
 */
import { act, render } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../utils/galleryAuthStorage', () => ({
  getActiveGallerySlug: () => 'demo',
  getGalleryToken: () => 'token',
  inferGallerySlugFromLocation: () => 'demo',
  resolveSlugFromRequestUrl: () => 'demo',
}));
vi.mock('../../../utils/url', () => ({ buildResourceUrl: (u: string) => `http://localhost${u}` }));

import { AuthenticatedImage } from '../AuthenticatedImage';

const ok = () => Promise.resolve({
  ok: true,
  blob: async () => new Blob(['x'], { type: 'image/png' }),
});
const loadFailed = () => Promise.reject(new TypeError('Load failed'));
const status = (code: number, headers: Record<string, string> = {}) => () => Promise.resolve({
  ok: false,
  status: code,
  statusText: 'x',
  headers: { get: (name: string) => headers[name] ?? null },
});

/** The observer callbacks registered by the component, so a test can drive them. */
type IOCallback = (entries: Array<{ isIntersecting: boolean }>) => void;
let observers: IOCallback[];

beforeEach(() => {
  vi.useFakeTimers();
  observers = [];
  URL.createObjectURL = vi.fn(() => 'blob:mock') as unknown as typeof URL.createObjectURL;
  URL.revokeObjectURL = vi.fn() as unknown as typeof URL.revokeObjectURL;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** Let every pending promise in the fetch/queue chain settle. */
const flush = () => act(async () => { await vi.advanceTimersByTimeAsync(0); });
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

/** IntersectionObserver stub that never fires on its own; tests drive it. */
function stubIntersectionObserver() {
  vi.stubGlobal('IntersectionObserver', class {
    constructor(cb: IOCallback) { observers.push(cb); }
    observe() {}
    disconnect() {}
    unobserve() {}
  });
}

describe('AuthenticatedImage retry', () => {
  it('retries a failed fetch after the delay and renders the image', async () => {
    const fetchMock = vi.fn().mockImplementationOnce(loadFailed).mockImplementation(ok);
    vi.stubGlobal('fetch', fetchMock);

    const { container } = render(<AuthenticatedImage src="/api/gallery/demo/thumbnail/1" alt="t" />);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(container.querySelector('img')).toBeNull();

    await advance(1999);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await advance(1);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:mock');
  });

  it('gives up after three retries with a doubling delay', async () => {
    const fetchMock = vi.fn().mockImplementation(loadFailed);
    vi.stubGlobal('fetch', fetchMock);

    render(<AuthenticatedImage src="/api/gallery/demo/thumbnail/1" alt="t" />);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await advance(2000); await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await advance(4000); await flush();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await advance(8000); await flush();
    expect(fetchMock).toHaveBeenCalledTimes(4);

    await advance(60_000); await flush();
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('waits until the placeholder is on screen before retrying', async () => {
    stubIntersectionObserver();
    const fetchMock = vi.fn().mockImplementationOnce(loadFailed).mockImplementation(ok);
    vi.stubGlobal('fetch', fetchMock);

    const { container } = render(<AuthenticatedImage src="/api/gallery/demo/thumbnail/1" alt="t" />);
    await flush();
    expect(observers).toHaveLength(1);

    // Delay elapsed, but the tile is not on screen: no retry.
    await advance(2000); await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Scrolled back into view: retry fires now, without another delay.
    act(() => observers[0]([{ isIntersecting: true }]));
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(container.querySelector('img')).not.toBeNull();
  });

  it('does not retry while the document is hidden, and does when it comes back', async () => {
    const fetchMock = vi.fn().mockImplementationOnce(loadFailed).mockImplementation(ok);
    vi.stubGlobal('fetch', fetchMock);
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');

    render(<AuthenticatedImage src="/api/gallery/demo/thumbnail/1" alt="t" />);
    await flush();
    await advance(2000); await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    visibility.mockReturnValue('visible');
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    visibility.mockRestore();
  });

  it('does not retry a final 4xx such as an expired token', async () => {
    const fetchMock = vi.fn().mockImplementation(status(401));
    vi.stubGlobal('fetch', fetchMock);

    render(<AuthenticatedImage src="/api/gallery/demo/thumbnail/1" alt="t" />);
    await flush();
    await advance(60_000); await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries a 5xx and a 429', async () => {
    const fetchMock = vi.fn()
      .mockImplementationOnce(status(503))
      .mockImplementationOnce(status(429))
      .mockImplementation(ok);
    vi.stubGlobal('fetch', fetchMock);

    const { container } = render(<AuthenticatedImage src="/api/gallery/demo/thumbnail/1" alt="t" />);
    await flush();
    await advance(2000); await flush();
    await advance(4000); await flush();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:mock');
  });

  it('waits out a Retry-After longer than the backoff before spending a retry', async () => {
    const fetchMock = vi.fn()
      .mockImplementationOnce(status(429, { 'Retry-After': '30' }))
      .mockImplementation(ok);
    vi.stubGlobal('fetch', fetchMock);

    const { container } = render(<AuthenticatedImage src="/api/gallery/demo/thumbnail/1" alt="t" />);
    await flush();
    // The 2 s backoff alone would have fired here.
    await advance(29_999); await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await advance(1); await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(container.querySelector('img')).not.toBeNull();
  });

  // Issue 1936: the lightbox passes the thumbnail as fallback. A preview
  // answered 503 while storage was unreachable used to stay a thumbnail.
  describe('with a fallbackSrc', () => {
    const PREVIEW = '/api/gallery/demo/photo/1/preview';
    const THUMB = '/api/gallery/demo/thumbnail/1';
    const byUrl = (handlers: Record<string, Array<() => Promise<unknown>>>) => vi.fn((url: string) => {
      const key = url.includes('/preview') ? 'preview' : 'thumb';
      const queue = handlers[key];
      return (queue.length > 1 ? queue.shift()! : queue[0])();
    });
    const calls = (mock: ReturnType<typeof vi.fn>, part: string) => mock.mock.calls.filter(([url]) => String(url).includes(part)).length;
    let serial: number;
    beforeEach(() => {
      serial = 0;
      URL.createObjectURL = vi.fn(() => `blob:mock-${serial += 1}`) as unknown as typeof URL.createObjectURL;
    });

    it('asks for src again behind the fallback and swaps it in, keeping the fallback on screen meanwhile', async () => {
      const fetchMock = byUrl({ preview: [status(503, { 'Retry-After': '5' }), ok], thumb: [ok] });
      vi.stubGlobal('fetch', fetchMock);

      const { container } = render(<AuthenticatedImage src={PREVIEW} fallbackSrc={THUMB} alt="t" />);
      await flush();
      expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:mock-1');

      // Retry-After (5 s) outlasts the 2 s backoff.
      await advance(4999);
      expect(calls(fetchMock, '/preview')).toBe(1);
      expect(URL.revokeObjectURL).not.toHaveBeenCalledWith('blob:mock-1');
      await advance(1);
      // The request is out; the stand-in is still what the guest sees.
      expect(calls(fetchMock, '/preview')).toBe(2);
      await flush();

      expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:mock-2');
      // The fallback's blob is let go once the preview has decoded, not before.
      expect(URL.revokeObjectURL).not.toHaveBeenCalledWith('blob:mock-1');
      await act(async () => { container.querySelector('img')!.dispatchEvent(new Event('load')); });
      expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock-1');
      expect(calls(fetchMock, '/thumbnail')).toBe(1);
      await advance(60_000); await flush();
      expect(calls(fetchMock, '/preview')).toBe(2);
    });

    it('never drops to the loading placeholder while the fallback stands in', async () => {
      let release: (value: unknown) => void = () => {};
      const pending = () => new Promise((resolve) => { release = resolve; });
      const fetchMock = byUrl({ preview: [status(503), pending], thumb: [ok] });
      vi.stubGlobal('fetch', fetchMock);

      const { container } = render(<AuthenticatedImage src={PREVIEW} fallbackSrc={THUMB} alt="t" />);
      await flush();
      await advance(2000);
      expect(calls(fetchMock, '/preview')).toBe(2);
      expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:mock-1');
      await act(async () => { release(await ok()); });
      await flush();
      expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:mock-2');
    });

    it('gives up after three retries and keeps the fallback', async () => {
      const fetchMock = byUrl({ preview: [status(503)], thumb: [ok] });
      vi.stubGlobal('fetch', fetchMock);

      const { container } = render(<AuthenticatedImage src={PREVIEW} fallbackSrc={THUMB} alt="t" />);
      await flush();
      await advance(2000); await flush();
      await advance(4000); await flush();
      await advance(8000); await flush();
      await advance(60_000); await flush();
      expect(calls(fetchMock, '/preview')).toBe(4);
      expect(calls(fetchMock, '/thumbnail')).toBe(1);
      expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:mock-1');
      expect(URL.revokeObjectURL).not.toHaveBeenCalledWith('blob:mock-1');
    });

    it('retries when both src and the fallback were refused, showing the plain fallback meanwhile', async () => {
      const fetchMock = byUrl({ preview: [status(503), ok], thumb: [status(503)] });
      vi.stubGlobal('fetch', fetchMock);

      const { container } = render(<AuthenticatedImage src={PREVIEW} fallbackSrc={THUMB} alt="t" />);
      await flush();
      expect(container.querySelector('img')?.getAttribute('src')).toBe(THUMB);
      await advance(2000); await flush();
      expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:mock-1');
    });

    it('does not retry a final 4xx on src', async () => {
      const fetchMock = byUrl({ preview: [status(404)], thumb: [ok] });
      vi.stubGlobal('fetch', fetchMock);

      const { container } = render(<AuthenticatedImage src={PREVIEW} fallbackSrc={THUMB} alt="t" />);
      await flush();
      await advance(60_000); await flush();
      expect(calls(fetchMock, '/preview')).toBe(1);
      expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:mock-1');
    });

    it('does not retry a src that arrived but would not decode', async () => {
      const fetchMock = byUrl({ preview: [ok], thumb: [ok] });
      vi.stubGlobal('fetch', fetchMock);

      const { container } = render(<AuthenticatedImage src={PREVIEW} fallbackSrc={THUMB} alt="t" />);
      await flush();
      await act(async () => { container.querySelector('img')!.dispatchEvent(new Event('error')); });
      expect(container.querySelector('img')?.getAttribute('src')).toBe(THUMB);
      await advance(60_000); await flush();
      expect(calls(fetchMock, '/preview')).toBe(1);
    });

    it('goes back to the fallback when the retried src arrives but will not decode', async () => {
      const fetchMock = byUrl({ preview: [status(503), ok], thumb: [ok] });
      vi.stubGlobal('fetch', fetchMock);

      const { container } = render(<AuthenticatedImage src={PREVIEW} fallbackSrc={THUMB} alt="t" />);
      await flush();
      await advance(2000); await flush();
      expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:mock-2');
      await act(async () => { container.querySelector('img')!.dispatchEvent(new Event('error')); });
      // The thumbnail already fetched, not a second request for it.
      expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:mock-1');
      expect(URL.revokeObjectURL).not.toHaveBeenCalledWith('blob:mock-1');
      expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock-2');
      await advance(60_000); await flush();
      expect(calls(fetchMock, '/preview')).toBe(2);
      expect(calls(fetchMock, '/thumbnail')).toBe(1);
    });

    it('waits out the cooldown the fallback asked for when both were refused', async () => {
      const fetchMock = byUrl({
        preview: [status(503)],
        thumb: [status(429, { 'Retry-After': '30' }), ok],
      });
      vi.stubGlobal('fetch', fetchMock);

      const { container } = render(<AuthenticatedImage src={PREVIEW} fallbackSrc={THUMB} alt="t" />);
      await flush();
      // The 2 s backoff alone would have asked both again here.
      await advance(29_999); await flush();
      expect(calls(fetchMock, '/thumbnail')).toBe(1);
      await advance(1); await flush();
      expect(calls(fetchMock, '/thumbnail')).toBe(2);
      expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:mock-1');
    });

    describe('drawn to a canvas', () => {
      /** Every hidden Image the canvas path creates; tests fire their load. */
      let created: HTMLImageElement[];
      const load = (img: HTMLImageElement) => img.onload?.(new Event('load'));
      beforeEach(() => {
        created = [];
        const RealImage = globalThis.Image;
        vi.stubGlobal('Image', class extends RealImage {
          constructor() {
            super();
            created.push(this as unknown as HTMLImageElement);
            Object.defineProperty(this, 'complete', { get: () => true });
            Object.defineProperty(this, 'naturalWidth', { get: () => 10 });
            Object.defineProperty(this, 'naturalHeight', { get: () => 10 });
          }
        });
        vi.spyOn(HTMLCanvasElement.prototype, 'getContext')
          .mockReturnValue({ drawImage: vi.fn() } as unknown as CanvasRenderingContext2D);
      });
      afterEach(() => vi.restoreAllMocks());

      it('keeps the drawn fallback visible until the retried src has decoded', async () => {
        const fetchMock = byUrl({ preview: [status(503), ok], thumb: [ok] });
        vi.stubGlobal('fetch', fetchMock);

        const { container } = render(<AuthenticatedImage src={PREVIEW} fallbackSrc={THUMB} alt="t" useCanvasRendering />);
        await flush();
        act(() => load(created[0]));
        expect(container.querySelector('canvas')?.style.opacity).toBe('1');

        await advance(2000); await flush();
        expect(calls(fetchMock, '/preview')).toBe(2);
        expect(created).toHaveLength(2);
        // The preview's bytes are here but not decoded: the thumbnail stays.
        expect(container.querySelector('canvas')?.style.opacity).toBe('1');
        expect(URL.revokeObjectURL).not.toHaveBeenCalledWith('blob:mock-1');

        act(() => load(created[1]));
        expect(container.querySelector('canvas')?.style.opacity).toBe('1');
        expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock-1');
      });

      it('does not let a late decode of the previous image release the new fallback', async () => {
        const fetchMock = byUrl({ preview: [ok, status(404)], thumb: [ok] });
        vi.stubGlobal('fetch', fetchMock);

        const { rerender } = render(<AuthenticatedImage src={PREVIEW} fallbackSrc={THUMB} alt="t" useCanvasRendering />);
        await flush();
        expect(created).toHaveLength(1);

        rerender(<AuthenticatedImage src="/api/gallery/demo/photo/2/preview" fallbackSrc="/api/gallery/demo/thumbnail/2" alt="t" useCanvasRendering />);
        // Inside one act, so the old Image's load lands after the new
        // fallback was fetched and before React has committed it.
        await act(async () => {
          await vi.advanceTimersByTimeAsync(0);
          load(created[0]);
        });
        expect(URL.createObjectURL).toHaveBeenCalledTimes(2);
        expect(URL.revokeObjectURL).not.toHaveBeenCalledWith('blob:mock-2');
      });
    });

    it('does not arm the next retry while the current one is still in flight', async () => {
      let release: (value: unknown) => void = () => {};
      const pending = () => new Promise((resolve) => { release = resolve; });
      const fetchMock = byUrl({ preview: [status(503), pending], thumb: [ok] });
      vi.stubGlobal('fetch', fetchMock);

      const { container } = render(<AuthenticatedImage src={PREVIEW} fallbackSrc={THUMB} alt="t" />);
      await flush();
      await advance(2000);
      expect(calls(fetchMock, '/preview')).toBe(2);
      // A preview that takes longer than the next backoff step is left alone.
      await advance(30_000); await flush();
      expect(calls(fetchMock, '/preview')).toBe(2);
      await act(async () => { release(await ok()); });
      await flush();
      expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:mock-2');
    });

    it('honours the Retry-After of a retry that failed behind the fallback', async () => {
      const fetchMock = byUrl({
        preview: [status(503), status(429, { 'Retry-After': '30' }), ok],
        thumb: [ok],
      });
      vi.stubGlobal('fetch', fetchMock);

      render(<AuthenticatedImage src={PREVIEW} fallbackSrc={THUMB} alt="t" />);
      await flush();
      await advance(2000); await flush();
      expect(calls(fetchMock, '/preview')).toBe(2);
      // The 4 s backoff alone would have fired here.
      await advance(29_999); await flush();
      expect(calls(fetchMock, '/preview')).toBe(2);
      await advance(1); await flush();
      expect(calls(fetchMock, '/preview')).toBe(3);
    });

    it('stops when a retry behind the fallback gets a final 4xx', async () => {
      const fetchMock = byUrl({ preview: [status(503), status(404)], thumb: [ok] });
      vi.stubGlobal('fetch', fetchMock);

      const { container } = render(<AuthenticatedImage src={PREVIEW} fallbackSrc={THUMB} alt="t" />);
      await flush();
      await advance(2000); await flush();
      await advance(60_000); await flush();
      expect(calls(fetchMock, '/preview')).toBe(2);
      expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:mock-1');
    });

    describe('observed element', () => {
      type Watch = { cb: IOCallback; el: Element | null; live: boolean };
      let watches: Watch[];
      const live = () => watches.filter((w) => w.live);
      beforeEach(() => {
        watches = [];
        vi.stubGlobal('IntersectionObserver', class {
          watch: Watch;
          constructor(cb: IOCallback) { this.watch = { cb, el: null, live: true }; watches.push(this.watch); }
          observe(el: Element) { this.watch.el = el; }
          disconnect() { this.watch.live = false; }
          unobserve() {}
        });
      });

      it('follows the stand-in when it moves between an img and a canvas', async () => {
        const fetchMock = byUrl({ preview: [status(503), ok], thumb: [ok] });
        vi.stubGlobal('fetch', fetchMock);

        const { container, rerender } = render(<AuthenticatedImage src={PREVIEW} fallbackSrc={THUMB} alt="t" />);
        await flush();
        expect(live().map((w) => w.el)).toEqual([container.querySelector('img')]);

        // The lightbox flips this prop as a slide becomes the current one.
        rerender(<AuthenticatedImage src={PREVIEW} fallbackSrc={THUMB} alt="t" useCanvasRendering />);
        await flush();
        expect(container.querySelector('canvas')).not.toBeNull();
        expect(live().map((w) => w.el)).toEqual([container.querySelector('canvas')]);

        rerender(<AuthenticatedImage src={PREVIEW} fallbackSrc={THUMB} alt="t" />);
        await flush();
        expect(live().map((w) => w.el)).toEqual([container.querySelector('img')]);

        // Rebinding did not restart the delay: it ran out while the element
        // changed, so being seen is all that is left to wait for.
        await advance(2000); await flush();
        expect(calls(fetchMock, '/preview')).toBe(1);
        rerender(<AuthenticatedImage src={PREVIEW} fallbackSrc={THUMB} alt="t" useCanvasRendering />);
        await flush();
        act(() => live()[0].cb([{ isIntersecting: true }]));
        await flush();
        expect(calls(fetchMock, '/preview')).toBe(2);
      });

      it('follows a thumbnail that only arrives on a retry, drawn to a canvas', async () => {
        const fetchMock = byUrl({ preview: [status(503)], thumb: [status(503), ok] });
        vi.stubGlobal('fetch', fetchMock);

        const { container } = render(<AuthenticatedImage src={PREVIEW} fallbackSrc={THUMB} alt="t" useCanvasRendering />);
        await flush();
        expect(live().map((w) => w.el)).toEqual([container.querySelector('img')]);

        await advance(2000); await flush();
        act(() => live()[0].cb([{ isIntersecting: true }]));
        await flush();
        expect(calls(fetchMock, '/thumbnail')).toBe(2);
        expect(container.querySelector('canvas')).not.toBeNull();
        expect(live().map((w) => w.el)).toEqual([container.querySelector('canvas')]);

        // The canvas is what is on screen now, and it carries the next retry.
        await advance(4000); await flush();
        act(() => live()[0].cb([{ isIntersecting: true }]));
        await flush();
        expect(calls(fetchMock, '/preview')).toBe(3);
      });
    });

    it('releases the stand-in when the image changes and on unmount', async () => {
      const fetchMock = byUrl({ preview: [status(503)], thumb: [ok] });
      vi.stubGlobal('fetch', fetchMock);

      const { rerender, unmount } = render(<AuthenticatedImage src={PREVIEW} fallbackSrc={THUMB} alt="t" />);
      await flush();
      rerender(<AuthenticatedImage src="/api/gallery/demo/photo/2/preview" fallbackSrc="/api/gallery/demo/thumbnail/2" alt="t" />);
      await flush();
      expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock-1');
      unmount();
      expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock-2');
    });
  });

  // What stands in for a picture that did not load is marked, so a caller
  // placing something relative to the whole picture can tell (issue 1733).
  it('marks the element while it shows the fallback, and not the picture itself', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementationOnce(status(503)).mockImplementation(ok));
    const onFallbackChange = vi.fn();
    const fetched = render(
      <AuthenticatedImage src="/api/gallery/demo/photo/1" fallbackSrc="/api/gallery/demo/thumbnail/1" alt="t" onFallbackChange={onFallbackChange} />,
    );
    await flush();
    expect(fetched.container.querySelector('img')?.getAttribute('data-fallback')).toBe('true');
    expect(onFallbackChange.mock.calls.map(([shown]) => shown)).toEqual([false, true]);
    fetched.unmount();

    vi.stubGlobal('fetch', vi.fn().mockImplementation(loadFailed));
    const plain = render(
      <AuthenticatedImage src="/api/gallery/demo/photo/1" fallbackSrc="/static/fallback.png" alt="t" />,
    );
    await flush();
    expect(plain.container.querySelector('img')?.getAttribute('data-fallback')).toBe('true');
    plain.unmount();

    vi.stubGlobal('fetch', vi.fn().mockImplementation(ok));
    const loaded = render(
      <AuthenticatedImage src="/api/gallery/demo/photo/1" fallbackSrc="/api/gallery/demo/thumbnail/1" alt="t" />,
    );
    await flush();
    expect(loaded.container.querySelector('img')?.hasAttribute('data-fallback')).toBe(false);
  });

  it('a new src gets a fresh retry budget', async () => {
    const fetchMock = vi.fn().mockImplementation(loadFailed);
    vi.stubGlobal('fetch', fetchMock);

    const { rerender } = render(<AuthenticatedImage src="/api/gallery/demo/thumbnail/1" alt="t" />);
    await flush();
    await advance(2000); await flush();
    await advance(4000); await flush();
    await advance(8000); await flush();
    expect(fetchMock).toHaveBeenCalledTimes(4);

    rerender(<AuthenticatedImage src="/api/gallery/demo/thumbnail/2" alt="t" />);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(5);
    await advance(2000); await flush();
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  // Issue 1733, E9: grid tiles take a smaller budget and want to know when
  // the image has been given up on, to show their placeholder.
  describe('maxRetries and onUnavailable', () => {
    it('stops after maxRetries and only then reports the image unavailable', async () => {
      const fetchMock = vi.fn().mockImplementation(status(503));
      vi.stubGlobal('fetch', fetchMock);
      const onUnavailable = vi.fn();

      render(<AuthenticatedImage src="/api/gallery/demo/thumbnail/1" alt="t" maxRetries={2} onUnavailable={onUnavailable} />);
      await flush();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(onUnavailable).not.toHaveBeenCalledWith(true);

      await advance(2000); await flush();
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(onUnavailable).not.toHaveBeenCalledWith(true);

      await advance(4000); await flush();
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(onUnavailable).toHaveBeenLastCalledWith(true);

      await advance(60_000); await flush();
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('reports a final 404 unavailable at once, without a retry', async () => {
      const fetchMock = vi.fn().mockImplementation(status(404));
      vi.stubGlobal('fetch', fetchMock);
      const onUnavailable = vi.fn();

      render(<AuthenticatedImage src="/api/gallery/demo/thumbnail/1" alt="t" maxRetries={2} onUnavailable={onUnavailable} />);
      await flush();
      expect(onUnavailable).toHaveBeenLastCalledWith(true);
      await advance(60_000); await flush();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('never reports unavailable when a retry recovers', async () => {
      const fetchMock = vi.fn().mockImplementationOnce(status(503)).mockImplementation(ok);
      vi.stubGlobal('fetch', fetchMock);
      const onUnavailable = vi.fn();

      const { container } = render(<AuthenticatedImage src="/api/gallery/demo/thumbnail/1" alt="t" maxRetries={2} onUnavailable={onUnavailable} />);
      await flush();
      await advance(2000); await flush();
      expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:mock');
      expect(onUnavailable).not.toHaveBeenCalledWith(true);
    });

    it('does not report unavailable as the last retry starts, only if it fails', async () => {
      const fetchMock = vi.fn()
        .mockImplementationOnce(status(503))
        .mockImplementationOnce(status(503))
        .mockImplementation(ok);
      vi.stubGlobal('fetch', fetchMock);
      const onUnavailable = vi.fn();

      const { container } = render(<AuthenticatedImage src="/api/gallery/demo/thumbnail/1" alt="t" maxRetries={2} onUnavailable={onUnavailable} />);
      await flush();
      await advance(2000); await flush();
      await advance(4000); await flush();
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:mock');
      expect(onUnavailable).not.toHaveBeenCalledWith(true);
    });

    it('takes the unavailable state back when src changes', async () => {
      const fetchMock = vi.fn().mockImplementationOnce(status(404)).mockImplementation(ok);
      vi.stubGlobal('fetch', fetchMock);
      const onUnavailable = vi.fn();

      const { rerender } = render(<AuthenticatedImage src="/api/gallery/demo/thumbnail/1" alt="t" onUnavailable={onUnavailable} />);
      await flush();
      expect(onUnavailable).toHaveBeenLastCalledWith(true);

      rerender(<AuthenticatedImage src="/api/gallery/demo/thumbnail/2" alt="t" onUnavailable={onUnavailable} />);
      await flush();
      expect(onUnavailable).toHaveBeenLastCalledWith(false);
    });

    it('is not unavailable while a fallback is on screen', async () => {
      const fetchMock = vi.fn().mockImplementation(status(404));
      vi.stubGlobal('fetch', fetchMock);
      const onUnavailable = vi.fn();

      render(<AuthenticatedImage src="/api/gallery/demo/photo/1" fallbackSrc="/api/gallery/demo/thumbnail/1" alt="t" onUnavailable={onUnavailable} />);
      await flush();
      expect(onUnavailable).not.toHaveBeenCalledWith(true);
    });
  });
});
