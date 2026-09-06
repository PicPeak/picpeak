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

  it('leaves the fallbackSrc path alone', async () => {
    const fetchMock = vi.fn().mockImplementation(loadFailed);
    vi.stubGlobal('fetch', fetchMock);

    const { container } = render(
      <AuthenticatedImage src="/api/gallery/demo/thumbnail/1" fallbackSrc="/static/fallback.png" alt="t" />,
    );
    await flush();
    // primary + fallback, then the plain <img> takes over — no retry loop.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(container.querySelector('img')?.getAttribute('src')).toBe('/static/fallback.png');
    await advance(60_000); await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
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
});
