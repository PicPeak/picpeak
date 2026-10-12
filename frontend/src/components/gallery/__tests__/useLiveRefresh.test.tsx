import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';

const getPhotoState = vi.fn();
vi.mock('../../../services/gallery.service', () => ({
  galleryService: { getPhotoState: (...args: unknown[]) => getPhotoState(...args) },
}));

import { useLiveRefresh, LIVE_REFRESH_INTERVAL_MS, LIVE_REFRESH_MAX_INTERVAL_MS } from '../hooks/useLiveRefresh';

const base = { slug: 'live', enabled: true, loadedCount: 10, loadedMaxId: 100, listVersion: 1 };

function setHidden(hidden: boolean) {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  document.dispatchEvent(new Event('visibilitychange'));
}
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

describe('useLiveRefresh', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    getPhotoState.mockReset();
    getPhotoState.mockResolvedValue({ count: 10, max_id: 100 });
    setHidden(false);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not poll while disabled', async () => {
    const { result } = renderHook(() => useLiveRefresh({ ...base, enabled: false }));
    await advance(LIVE_REFRESH_INTERVAL_MS * 5);
    expect(getPhotoState).not.toHaveBeenCalled();
    expect(result.current).toBe(0);
  });

  it('polls once per interval and reports how many photos the server has beyond the list', async () => {
    getPhotoState.mockResolvedValue({ count: 13, max_id: 103 });
    const { result } = renderHook(() => useLiveRefresh(base));
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
    const { result } = renderHook(() => useLiveRefresh(base));
    await advance(LIVE_REFRESH_INTERVAL_MS);
    expect(result.current).toBe(0);
    getPhotoState.mockResolvedValue({ count: 10, max_id: 101 });
    await advance(LIVE_REFRESH_INTERVAL_MS);
    expect(result.current).toBe(1);
  });

  it('clears the notice once the list was reloaded', async () => {
    getPhotoState.mockResolvedValue({ count: 12, max_id: 102 });
    const { result, rerender } = renderHook((props) => useLiveRefresh(props), { initialProps: base });
    await advance(LIVE_REFRESH_INTERVAL_MS);
    expect(result.current).toBe(2);
    // The reload came back one photo short of the answer (deleted meanwhile).
    rerender({ ...base, loadedCount: 11, loadedMaxId: 102, listVersion: 2 });
    expect(result.current).toBe(0);
  });

  it('pauses while the tab is hidden and resumes when it is visible again', async () => {
    renderHook(() => useLiveRefresh(base));
    act(() => setHidden(true));
    await advance(LIVE_REFRESH_INTERVAL_MS * 10);
    expect(getPhotoState).not.toHaveBeenCalled();
    act(() => setHidden(false));
    await advance(LIVE_REFRESH_INTERVAL_MS);
    expect(getPhotoState).toHaveBeenCalledTimes(1);
  });

  it('doubles the interval on an error up to the cap, and returns to the base on success', async () => {
    getPhotoState.mockRejectedValue({ response: { status: 429 } });
    const { result } = renderHook(() => useLiveRefresh(base));
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
    const { unmount } = renderHook(() => useLiveRefresh(base));
    unmount();
    await advance(LIVE_REFRESH_INTERVAL_MS * 3);
    expect(getPhotoState).not.toHaveBeenCalled();
  });
});
