import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';

const getPhotoState = vi.fn();
vi.mock('../../../services/gallery.service', () => ({
  galleryService: { getPhotoState: (...args: unknown[]) => getPhotoState(...args) },
}));

import {
  useProcessingRefresh, PROCESSING_POLL_DEADLINE_MS, PROCESSING_POLL_MAX_UNCHANGED,
} from '../hooks/useProcessingRefresh';
import { LIVE_REFRESH_INTERVAL_MS } from '../hooks/useLiveRefresh';

const onLanded = vi.fn();
const base = { slug: 'live', enabled: true, loadedCount: 10, loadedMaxId: 100, listUpdatedAt: 1, onLanded };

function setHidden(hidden: boolean) {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  document.dispatchEvent(new Event('visibilitychange'));
}
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

// Issue 2263: media still processing is followed until it lands.
describe('useProcessingRefresh', () => {
  beforeEach(() => {
    vi.useFakeTimers();
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
  it('gives up after ten answers in a row that bring nothing new', async () => {
    const { result } = renderHook(() => useProcessingRefresh(base));
    await advance(LIVE_REFRESH_INTERVAL_MS * PROCESSING_POLL_MAX_UNCHANGED);
    expect(getPhotoState).toHaveBeenCalledTimes(PROCESSING_POLL_MAX_UNCHANGED);
    expect(result.current).toBe(true);
    await advance(LIVE_REFRESH_INTERVAL_MS * 5);
    expect(getPhotoState).toHaveBeenCalledTimes(PROCESSING_POLL_MAX_UNCHANGED);
    expect(onLanded).not.toHaveBeenCalled();
  });

  it('gives up 30 minutes after the first processing answer', async () => {
    // The list never catches up (each answer reloads it), so only the
    // deadline can end this.
    getPhotoState.mockResolvedValue({ count: 11, max_id: 101, processing: true });
    const { result } = renderHook(() => useProcessingRefresh(base));
    await advance(LIVE_REFRESH_INTERVAL_MS);
    expect(result.current).toBe(false);
    await advance(PROCESSING_POLL_DEADLINE_MS);
    expect(result.current).toBe(true);
    const calls = getPhotoState.mock.calls.length;
    expect(calls).toBe(PROCESSING_POLL_DEADLINE_MS / LIVE_REFRESH_INTERVAL_MS + 1);
    await advance(LIVE_REFRESH_INTERVAL_MS * 5);
    expect(getPhotoState).toHaveBeenCalledTimes(calls);
  });

  it('starts over on the next list fetch after giving up', async () => {
    const { result, rerender } = renderHook((props) => useProcessingRefresh(props), { initialProps: base });
    await advance(LIVE_REFRESH_INTERVAL_MS * PROCESSING_POLL_MAX_UNCHANGED);
    expect(result.current).toBe(true);
    // A re-render without a new list keeps it stopped.
    rerender({ ...base });
    await advance(LIVE_REFRESH_INTERVAL_MS * 3);
    expect(getPhotoState).toHaveBeenCalledTimes(PROCESSING_POLL_MAX_UNCHANGED);
    // The list was fetched again (navigation, focus, the live-refresh pill).
    rerender({ ...base, listUpdatedAt: 2 });
    expect(result.current).toBe(false);
    await advance(LIVE_REFRESH_INTERVAL_MS);
    expect(getPhotoState).toHaveBeenCalledTimes(PROCESSING_POLL_MAX_UNCHANGED + 1);
    // With a fresh budget: another full run before it gives up again.
    await advance(LIVE_REFRESH_INTERVAL_MS * (PROCESSING_POLL_MAX_UNCHANGED - 1));
    expect(result.current).toBe(true);
    expect(getPhotoState).toHaveBeenCalledTimes(PROCESSING_POLL_MAX_UNCHANGED * 2);
  });
});
