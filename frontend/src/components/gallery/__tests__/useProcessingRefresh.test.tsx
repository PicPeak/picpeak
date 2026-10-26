import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';

const getPhotoState = vi.fn();
vi.mock('../../../services/gallery.service', () => ({
  galleryService: { getPhotoState: (...args: unknown[]) => getPhotoState(...args) },
}));

import { useProcessingRefresh } from '../hooks/useProcessingRefresh';
import { LIVE_REFRESH_INTERVAL_MS } from '../hooks/useLiveRefresh';

const onLanded = vi.fn();
const base = { slug: 'live', enabled: true, loadedCount: 10, loadedMaxId: 100, onLanded };

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
});
