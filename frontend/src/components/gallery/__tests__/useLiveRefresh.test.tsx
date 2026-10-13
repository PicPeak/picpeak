import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const getPhotoState = vi.fn();
vi.mock('../../../services/gallery.service', () => ({
  galleryService: { getPhotoState: (...args: unknown[]) => getPhotoState(...args) },
}));

import { useLiveRefresh, LIVE_REFRESH_INTERVAL_MS, LIVE_REFRESH_MAX_INTERVAL_MS } from '../hooks/useLiveRefresh';

const base = { slug: 'live', enabled: true, loadedCount: 10, loadedMaxId: 100 };
const LIST_KEY = ['gallery-photos', 'live', 'all', 'guest_1'];

let queryClient: QueryClient;
const wrapper = ({ children }: { children: React.ReactNode }) => (
  <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
);
/** The list was fetched again (not a manual cache write). */
const reloadList = () => act(async () => {
  await queryClient.fetchQuery({ queryKey: LIST_KEY, queryFn: async () => ({ photos: [] }), staleTime: 0 });
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function setHidden(hidden: boolean) {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  document.dispatchEvent(new Event('visibilitychange'));
}
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

describe('useLiveRefresh', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    getPhotoState.mockReset();
    getPhotoState.mockResolvedValue({ count: 10, max_id: 100 });
    setHidden(false);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not poll while disabled', async () => {
    const { result } = renderHook(() => useLiveRefresh({ ...base, enabled: false }), { wrapper });
    await advance(LIVE_REFRESH_INTERVAL_MS * 5);
    expect(getPhotoState).not.toHaveBeenCalled();
    expect(result.current).toBe(0);
  });

  it('polls once per interval and reports how many photos the server has beyond the list', async () => {
    getPhotoState.mockResolvedValue({ count: 13, max_id: 103 });
    const { result } = renderHook(() => useLiveRefresh(base), { wrapper });
    await advance(LIVE_REFRESH_INTERVAL_MS - 1);
    expect(getPhotoState).not.toHaveBeenCalled();
    await advance(1);
    expect(getPhotoState).toHaveBeenCalledTimes(1);
    expect(getPhotoState.mock.calls[0][0]).toBe('live');
    expect(result.current).toBe(3);
    await advance(LIVE_REFRESH_INTERVAL_MS);
    expect(getPhotoState).toHaveBeenCalledTimes(2);
  });

  it('gives no notice when photos were deleted, and one for a replaced photo', async () => {
    getPhotoState.mockResolvedValue({ count: 8, max_id: 100 });
    const { result } = renderHook(() => useLiveRefresh(base), { wrapper });
    await advance(LIVE_REFRESH_INTERVAL_MS);
    expect(result.current).toBe(0);
    getPhotoState.mockResolvedValue({ count: 10, max_id: 101 });
    await advance(LIVE_REFRESH_INTERVAL_MS);
    expect(result.current).toBe(1);
  });

  it('clears the notice once the list was reloaded', async () => {
    getPhotoState.mockResolvedValue({ count: 12, max_id: 102 });
    const { result, rerender } = renderHook((props) => useLiveRefresh(props), { initialProps: base, wrapper });
    await advance(LIVE_REFRESH_INTERVAL_MS);
    expect(result.current).toBe(2);
    // The reload came back one photo short of the answer (deleted meanwhile).
    await reloadList();
    rerender({ ...base, loadedCount: 11, loadedMaxId: 102 });
    expect(result.current).toBe(0);
  });

  it('keeps the notice when a like or rating only patches the cached list', async () => {
    getPhotoState.mockResolvedValue({ count: 12, max_id: 102 });
    const { result } = renderHook(() => useLiveRefresh(base), { wrapper });
    await advance(LIVE_REFRESH_INTERVAL_MS);
    expect(result.current).toBe(2);
    // What useFeedbackChange and TileRating do: the rows change, the list
    // still holds the same photos.
    act(() => { queryClient.setQueryData(LIST_KEY, { photos: [] }); });
    expect(result.current).toBe(2);
  });

  it('drops an answer that was asked for before the list was reloaded', async () => {
    const early = deferred<{ count: number; max_id: number | null }>();
    getPhotoState.mockReturnValueOnce(early.promise);
    const { result, rerender } = renderHook((props) => useLiveRefresh(props), { initialProps: base, wrapper });
    await advance(LIVE_REFRESH_INTERVAL_MS);
    expect(getPhotoState).toHaveBeenCalledTimes(1);
    // The poll counted 12 before a deletion; the list loaded after it has 11.
    await reloadList();
    rerender({ ...base, loadedCount: 11, loadedMaxId: 102 });
    await act(async () => { early.resolve({ count: 12, max_id: 102 }); });
    expect(result.current).toBe(0);
    // The loop goes on, and the next answer counts again.
    getPhotoState.mockResolvedValue({ count: 13, max_id: 104 });
    await advance(LIVE_REFRESH_INTERVAL_MS);
    expect(getPhotoState).toHaveBeenCalledTimes(2);
    expect(result.current).toBe(2);
  });

  it('keeps the notice when a list request from before the answer comes back', async () => {
    // A refetch is out and has read 10 photos; two arrive; the poll sees 12.
    const oldList = deferred<{ photos: never[] }>();
    let listRequest!: Promise<unknown>;
    getPhotoState.mockResolvedValue({ count: 12, max_id: 102 });
    const { result } = renderHook(() => useLiveRefresh(base), { wrapper });
    act(() => { listRequest = queryClient.fetchQuery({ queryKey: LIST_KEY, queryFn: () => oldList.promise }); });
    await advance(LIVE_REFRESH_INTERVAL_MS);
    expect(result.current).toBe(2);
    await act(async () => { oldList.resolve({ photos: [] }); await listRequest; });
    expect(result.current).toBe(2);
    // A list asked for after the answer still clears it.
    await reloadList();
    expect(result.current).toBe(0);
  });

  it('keeps the notice when the older list request was already out as the hook mounted', async () => {
    const oldList = deferred<{ photos: never[] }>();
    let listRequest!: Promise<unknown>;
    act(() => { listRequest = queryClient.fetchQuery({ queryKey: LIST_KEY, queryFn: () => oldList.promise }); });
    getPhotoState.mockResolvedValue({ count: 12, max_id: 102 });
    const { result } = renderHook(() => useLiveRefresh(base), { wrapper });
    await advance(LIVE_REFRESH_INTERVAL_MS);
    expect(result.current).toBe(2);
    await act(async () => { oldList.resolve({ photos: [] }); await listRequest; });
    expect(result.current).toBe(2);
  });

  it('dates a retried list request from its retry, not from the attempt that failed', async () => {
    const firstAttempt = deferred<{ photos: never[] }>();
    const queryFn = vi.fn()
      .mockImplementationOnce(() => firstAttempt.promise)
      .mockResolvedValue({ photos: [] });
    getPhotoState.mockResolvedValue({ count: 12, max_id: 102 });
    const { result, rerender } = renderHook((props) => useLiveRefresh(props), { initialProps: base, wrapper });
    act(() => { void queryClient.fetchQuery({ queryKey: LIST_KEY, queryFn, retry: 1, retryDelay: 100 }); });
    await advance(LIVE_REFRESH_INTERVAL_MS);
    expect(result.current).toBe(2);
    // The first attempt fails after the poll; the retry reads the gallery
    // after a deletion and is the newer of the two.
    await act(async () => { firstAttempt.reject(new Error('network')); });
    await advance(100);
    expect(queryFn).toHaveBeenCalledTimes(2);
    rerender({ ...base, loadedCount: 11, loadedMaxId: 102 });
    expect(result.current).toBe(0);
  });

  it('keeps one poll loop when the tab is hidden and shown during a request', async () => {
    const slow = deferred<{ count: number; max_id: number | null }>();
    getPhotoState.mockReturnValueOnce(slow.promise);
    renderHook(() => useLiveRefresh(base), { wrapper });
    await advance(LIVE_REFRESH_INTERVAL_MS);
    expect(getPhotoState).toHaveBeenCalledTimes(1);
    act(() => setHidden(true));
    act(() => setHidden(false));
    await act(async () => { slow.resolve({ count: 10, max_id: 100 }); });
    await advance(LIVE_REFRESH_INTERVAL_MS);
    expect(getPhotoState).toHaveBeenCalledTimes(2);
    await advance(LIVE_REFRESH_INTERVAL_MS);
    expect(getPhotoState).toHaveBeenCalledTimes(3);
  });

  it('pauses while the tab is hidden and resumes when it is visible again', async () => {
    renderHook(() => useLiveRefresh(base), { wrapper });
    act(() => setHidden(true));
    await advance(LIVE_REFRESH_INTERVAL_MS * 10);
    expect(getPhotoState).not.toHaveBeenCalled();
    act(() => setHidden(false));
    await advance(LIVE_REFRESH_INTERVAL_MS);
    expect(getPhotoState).toHaveBeenCalledTimes(1);
  });

  it('doubles the interval on an error up to the cap, and returns to the base on success', async () => {
    getPhotoState.mockRejectedValue({ response: { status: 429 } });
    const { result } = renderHook(() => useLiveRefresh(base), { wrapper });
    await advance(LIVE_REFRESH_INTERVAL_MS);
    expect(getPhotoState).toHaveBeenCalledTimes(1);
    await advance(LIVE_REFRESH_INTERVAL_MS);
    expect(getPhotoState).toHaveBeenCalledTimes(1);
    await advance(LIVE_REFRESH_INTERVAL_MS);
    expect(getPhotoState).toHaveBeenCalledTimes(2);
    expect(result.current).toBe(0);

    // 80 s, 160 s, then the cap: never longer than five minutes apart.
    await advance(80_000 + 160_000);
    expect(getPhotoState).toHaveBeenCalledTimes(4);
    await advance(LIVE_REFRESH_MAX_INTERVAL_MS);
    expect(getPhotoState).toHaveBeenCalledTimes(5);
    await advance(LIVE_REFRESH_MAX_INTERVAL_MS);
    expect(getPhotoState).toHaveBeenCalledTimes(6);

    getPhotoState.mockResolvedValue({ count: 11, max_id: 101 });
    await advance(LIVE_REFRESH_MAX_INTERVAL_MS);
    expect(getPhotoState).toHaveBeenCalledTimes(7);
    expect(result.current).toBe(1);
    await advance(LIVE_REFRESH_INTERVAL_MS);
    expect(getPhotoState).toHaveBeenCalledTimes(8);
  });

  it('stops polling on unmount', async () => {
    const { unmount } = renderHook(() => useLiveRefresh(base), { wrapper });
    unmount();
    await advance(LIVE_REFRESH_INTERVAL_MS * 3);
    expect(getPhotoState).not.toHaveBeenCalled();
  });
});
