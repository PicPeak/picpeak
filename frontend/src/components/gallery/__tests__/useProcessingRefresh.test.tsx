import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { act, renderHook as renderHookBare } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const getPhotoState = vi.fn();
vi.mock('../../../services/gallery.service', () => ({
  galleryService: { getPhotoState: (...args: unknown[]) => getPhotoState(...args) },
}));

import {
  useProcessingRefresh, PROCESSING_POLL_DEADLINE_MS,
} from '../hooks/useProcessingRefresh';
import { LIVE_REFRESH_INTERVAL_MS } from '../hooks/useLiveRefresh';

const onLanded = vi.fn();
const base = { slug: 'live', enabled: true, loadedCount: 10, loadedMaxId: 100, onLanded };

let queryClient: QueryClient;
const wrapper = ({ children }: { children: React.ReactNode }) => (
  <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
);
const renderHook: typeof renderHookBare = (callback, options) => renderHookBare(callback, { wrapper, ...options });
const listKey = ['gallery-photos', 'live', 'all', null, 'guest'];

function setHidden(hidden: boolean) {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  document.dispatchEvent(new Event('visibilitychange'));
}
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

// Issue 2263: media still processing is followed until it lands.
describe('useProcessingRefresh', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    getPhotoState.mockReset();
    onLanded.mockReset();
    getPhotoState.mockResolvedValue({ count: 10, max_id: 100, processing: true });
    setHidden(false);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not poll while nothing is processing', async () => {
    renderHook(() => useProcessingRefresh({ ...base, enabled: false }));
    await advance(LIVE_REFRESH_INTERVAL_MS * 5);
    expect(getPhotoState).not.toHaveBeenCalled();
    expect(onLanded).not.toHaveBeenCalled();
  });

  it('polls once per interval and leaves the list alone while nothing changed', async () => {
    renderHook(() => useProcessingRefresh(base));
    await advance(LIVE_REFRESH_INTERVAL_MS - 1);
    expect(getPhotoState).not.toHaveBeenCalled();
    await advance(1);
    await advance(LIVE_REFRESH_INTERVAL_MS * 2);
    expect(getPhotoState).toHaveBeenCalledTimes(3);
    expect(onLanded).not.toHaveBeenCalled();
  });

  it('reloads the list once the video has landed', async () => {
    renderHook(() => useProcessingRefresh(base));
    await advance(LIVE_REFRESH_INTERVAL_MS);
    expect(onLanded).not.toHaveBeenCalled();
    getPhotoState.mockResolvedValue({ count: 11, max_id: 101, processing: false });
    await advance(LIVE_REFRESH_INTERVAL_MS);
    expect(onLanded).toHaveBeenCalledTimes(1);
  });

  it('reloads when one of several has landed and stops once the reloaded list is settled', async () => {
    const { rerender } = renderHook((props) => useProcessingRefresh(props), { initialProps: base });
    getPhotoState.mockResolvedValue({ count: 11, max_id: 101, processing: true });
    await advance(LIVE_REFRESH_INTERVAL_MS);
    expect(onLanded).toHaveBeenCalledTimes(1);
    // The reloaded list holds it; the next poll matches and changes nothing.
    rerender({ ...base, loadedCount: 11, loadedMaxId: 101 });
    await advance(LIVE_REFRESH_INTERVAL_MS);
    expect(onLanded).toHaveBeenCalledTimes(1);
    // The list now says nothing is processing: no more polls.
    rerender({ ...base, loadedCount: 11, loadedMaxId: 101, enabled: false });
    const calls = getPhotoState.mock.calls.length;
    await advance(LIVE_REFRESH_INTERVAL_MS * 3);
    expect(getPhotoState).toHaveBeenCalledTimes(calls);
  });

  it('reloads when processing ended with nothing new (a failed transcode)', async () => {
    getPhotoState.mockResolvedValue({ count: 10, max_id: 100, processing: false });
    renderHook(() => useProcessingRefresh(base));
    await advance(LIVE_REFRESH_INTERVAL_MS);
    expect(onLanded).toHaveBeenCalledTimes(1);
  });

  it('treats the 404 of a gallery with live refresh off as "done"', async () => {
    getPhotoState.mockRejectedValue({ response: { status: 404 } });
    renderHook(() => useProcessingRefresh(base));
    await advance(LIVE_REFRESH_INTERVAL_MS);
    expect(onLanded).toHaveBeenCalledTimes(1);
  });

  it('backs off silently on other failures', async () => {
    getPhotoState.mockRejectedValue({ response: { status: 429 } });
    renderHook(() => useProcessingRefresh(base));
    await advance(LIVE_REFRESH_INTERVAL_MS);
    expect(getPhotoState).toHaveBeenCalledTimes(1);
    await advance(LIVE_REFRESH_INTERVAL_MS);
    expect(getPhotoState).toHaveBeenCalledTimes(1);
    await advance(LIVE_REFRESH_INTERVAL_MS);
    expect(getPhotoState).toHaveBeenCalledTimes(2);
    expect(onLanded).not.toHaveBeenCalled();
  });

  it('does not poll while the tab is hidden', async () => {
    renderHook(() => useProcessingRefresh(base));
    setHidden(true);
    await advance(LIVE_REFRESH_INTERVAL_MS * 3);
    expect(getPhotoState).not.toHaveBeenCalled();
    setHidden(false);
    await advance(LIVE_REFRESH_INTERVAL_MS);
    expect(getPhotoState).toHaveBeenCalledTimes(1);
  });

  // Issue 2274: a row stuck in processing must not be polled forever.
  it('keeps polling a long transcode whose numbers do not move', async () => {
    const { result } = renderHook(() => useProcessingRefresh(base));
    await advance(LIVE_REFRESH_INTERVAL_MS * 30);
    expect(getPhotoState).toHaveBeenCalledTimes(30);
    expect(result.current).toBe(false);
  });

  it('gives up 30 minutes after the first processing answer', async () => {
    const { result } = renderHook(() => useProcessingRefresh(base));
    await advance(LIVE_REFRESH_INTERVAL_MS);
    expect(result.current).toBe(false);
    await advance(PROCESSING_POLL_DEADLINE_MS);
    expect(result.current).toBe(true);
    const calls = getPhotoState.mock.calls.length;
    expect(calls).toBe(PROCESSING_POLL_DEADLINE_MS / LIVE_REFRESH_INTERVAL_MS + 1);
    await advance(LIVE_REFRESH_INTERVAL_MS * 5);
    expect(getPhotoState).toHaveBeenCalledTimes(calls);
    expect(onLanded).not.toHaveBeenCalled();
  });

  it('starts over on the next list fetch after giving up', async () => {
    const { result, rerender } = renderHook((props) => useProcessingRefresh(props), { initialProps: base });
    const run = PROCESSING_POLL_DEADLINE_MS + LIVE_REFRESH_INTERVAL_MS;
    await advance(run);
    expect(result.current).toBe(true);
    const calls = getPhotoState.mock.calls.length;
    // A re-render without a new list keeps it stopped.
    rerender({ ...base });
    await advance(LIVE_REFRESH_INTERVAL_MS * 3);
    expect(getPhotoState).toHaveBeenCalledTimes(calls);
    // A like or a rating patching the cached rows is no new list.
    act(() => { queryClient.setQueryData(listKey, { photos: [] }); });
    expect(result.current).toBe(true);
    await advance(LIVE_REFRESH_INTERVAL_MS * 3);
    expect(getPhotoState).toHaveBeenCalledTimes(calls);
    // The list was fetched again (navigation, focus, the live-refresh pill).
    await act(async () => { await queryClient.fetchQuery({ queryKey: listKey, queryFn: async () => ({ photos: [] }) }); });
    expect(result.current).toBe(false);
    await advance(LIVE_REFRESH_INTERVAL_MS);
    expect(getPhotoState).toHaveBeenCalledTimes(calls + 1);
    // With a fresh deadline: another full run before it gives up again.
    await advance(run - LIVE_REFRESH_INTERVAL_MS * 2);
    expect(result.current).toBe(false);
    await advance(LIVE_REFRESH_INTERVAL_MS);
    expect(result.current).toBe(true);
    expect(getPhotoState).toHaveBeenCalledTimes(calls * 2);
  });
});
