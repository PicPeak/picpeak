/**
 * Issue 2275: a poster URL handed to an element (the lightbox player's
 * `<video poster>`) follows a poster the server is still building, on the
 * same X-Poster-Pending / Retry-After budget AuthenticatedImage uses.
 */
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../utils/galleryAuthStorage', () => ({
  getActiveGallerySlug: () => 'demo',
  getGalleryToken: () => 'token',
  inferGallerySlugFromLocation: () => 'demo',
  resolveSlugFromRequestUrl: () => 'demo',
}));
vi.mock('../../../../utils/url', () => ({ buildResourceUrl: (u: string) => `http://localhost${u}` }));

import { usePendingAwareImageUrl } from '../usePendingAwareImageUrl';
import { MAX_PENDING_POLLS } from '../../../../utils/authenticatedImageFetch';

const headers = (values: Record<string, string>) => ({ get: (name: string) => values[name] ?? null });
const pending = () => Promise.resolve({
  ok: true,
  blob: async () => new Blob(['p'], { type: 'image/jpeg' }),
  headers: headers({ 'X-Poster-Pending': '1', 'Retry-After': '10' }),
});
const real = () => Promise.resolve({
  ok: true,
  blob: async () => new Blob(['r'], { type: 'image/jpeg' }),
  headers: headers({}),
});
const status = (code: number) => () => Promise.resolve({ ok: false, status: code, statusText: 'x', headers: headers({}) });

const flush = () => act(async () => { await vi.advanceTimersByTimeAsync(0); });
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

let n: number;
beforeEach(() => {
  vi.useFakeTimers();
  n = 0;
  URL.createObjectURL = vi.fn(() => `blob:${++n}`) as unknown as typeof URL.createObjectURL;
  URL.revokeObjectURL = vi.fn() as unknown as typeof URL.revokeObjectURL;
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('usePendingAwareImageUrl (issue 2275)', () => {
  it('shows the stand-in, asks again after Retry-After and swaps in the real poster', async () => {
    const fetchMock = vi.fn().mockImplementationOnce(pending).mockImplementation(real);
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => usePendingAwareImageUrl('/api/gallery/demo/thumbnail/1'));
    await flush();
    expect(result.current).toBe('blob:1');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await advance(9_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.current).toBe('blob:2');
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:1');

    // The real poster is final: nothing asks again.
    await advance(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('stops once the server answers a final 4xx, keeping the stand-in', async () => {
    const fetchMock = vi.fn().mockImplementationOnce(pending).mockImplementation(status(403));
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => usePendingAwareImageUrl('/api/gallery/demo/thumbnail/1'));
    await flush();
    await advance(10_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await advance(120_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.current).toBe('blob:1');
  });

  it('keeps the stand-in once the pending budget is spent', async () => {
    const fetchMock = vi.fn().mockImplementation(pending);
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => usePendingAwareImageUrl('/api/gallery/demo/thumbnail/1'));
    await flush();
    for (let i = 0; i < MAX_PENDING_POLLS + 3; i += 1) await advance(10_000);
    expect(fetchMock).toHaveBeenCalledTimes(1 + MAX_PENDING_POLLS);
    expect(result.current).toBe(`blob:${1 + MAX_PENDING_POLLS}`);
  });

  it('shows the URL itself while the fetch waits for a queue slot', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    const { result } = renderHook(() => usePendingAwareImageUrl('/api/gallery/demo/thumbnail/1'));
    expect(result.current).toBe('/api/gallery/demo/thumbnail/1');
  });

  it('keeps the URL itself when the first ask fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => Promise.reject(new TypeError('Load failed'))));
    const { result } = renderHook(() => usePendingAwareImageUrl('/api/gallery/demo/thumbnail/1'));
    await flush();
    expect(result.current).toBe('/api/gallery/demo/thumbnail/1');
  });

  it('waits for a hidden tab to come back before asking again', async () => {
    const fetchMock = vi.fn().mockImplementationOnce(pending).mockImplementation(real);
    vi.stubGlobal('fetch', fetchMock);
    let state: DocumentVisibilityState = 'hidden';
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => state);
    const { result } = renderHook(() => usePendingAwareImageUrl('/api/gallery/demo/thumbnail/1'));
    await flush();
    await advance(30_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    state = 'visible';
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.current).toBe('blob:2');
  });

  it('sends the gallery token and nothing for a missing src', async () => {
    const fetchMock = vi.fn().mockImplementation(real);
    vi.stubGlobal('fetch', fetchMock);
    const { result, rerender } = renderHook(({ src }) => usePendingAwareImageUrl(src), {
      initialProps: { src: null as string | null },
    });
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current).toBeUndefined();
    rerender({ src: '/api/gallery/demo/thumbnail/1' });
    await flush();
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost/api/gallery/demo/thumbnail/1',
      expect.objectContaining({ credentials: 'include', headers: { Authorization: 'Bearer token' } }),
    );
  });
});
