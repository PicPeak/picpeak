import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useScreenWakeLock } from '../useScreenWakeLock';

const flush = () => new Promise((resolve) => { setTimeout(resolve, 0); });

function installWakeLock() {
  const sentinels: Array<{ released: boolean; release: ReturnType<typeof vi.fn> }> = [];
  const request = vi.fn(async () => {
    const sentinel = { released: false, release: vi.fn(async () => { sentinel.released = true; }) };
    sentinels.push(sentinel);
    return sentinel;
  });
  Object.defineProperty(navigator, 'wakeLock', { value: { request }, configurable: true });
  return { request, sentinels };
}

afterEach(() => {
  delete (navigator as unknown as Record<string, unknown>).wakeLock;
  vi.restoreAllMocks();
});

describe('useScreenWakeLock', () => {
  it('does nothing where the API is missing', () => {
    expect(() => renderHook(() => useScreenWakeLock(true)).unmount()).not.toThrow();
  });

  it('holds the lock while active and releases it when done', async () => {
    const { request, sentinels } = installWakeLock();
    const { rerender } = renderHook(({ active }) => useScreenWakeLock(active), { initialProps: { active: true } });
    await flush();
    expect(request).toHaveBeenCalledWith('screen');
    rerender({ active: false });
    expect(sentinels[0].release).toHaveBeenCalled();
  });

  it('takes the lock again when the page becomes visible', async () => {
    const { request, sentinels } = installWakeLock();
    renderHook(() => useScreenWakeLock(true));
    await flush();
    sentinels[0].released = true; // the browser dropped it while hidden
    document.dispatchEvent(new Event('visibilitychange'));
    await flush();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('goes on without a lock the browser refuses', async () => {
    Object.defineProperty(navigator, 'wakeLock', {
      value: { request: vi.fn(async () => { throw new Error('NotAllowedError'); }) }, configurable: true,
    });
    const { unmount } = renderHook(() => useScreenWakeLock(true));
    await flush();
    expect(() => unmount()).not.toThrow();
  });
});
