/**
 * Issue 2043: one single-photo download per photo at a time. `mutate` answers
 * false and starts nothing while the photo is still being prepared, across
 * every hook instance (tile, carousel and lightbox each hold their own).
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const svc = vi.hoisted(() => ({ downloadPhoto: vi.fn(), savePhotoToDevice: vi.fn() }));
vi.mock('../../services', () => ({ galleryService: svc }));
vi.mock('react-toastify', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { useDownloadPhoto, useSavePhotoToDevice } from '../useGallery';
import { isPhotoDownloadPending } from '../usePhotoDownloadPending';

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>
);

describe('single-photo download hooks (issue 2043)', () => {
  it('starts one download per photo until it settles, shared between hook instances', async () => {
    let finish!: () => void;
    svc.downloadPhoto.mockReturnValue(new Promise<void>((resolve) => { finish = resolve; }));
    svc.savePhotoToDevice.mockResolvedValue(undefined);
    const grid = renderHook(() => useDownloadPhoto(), { wrapper });
    const lightbox = renderHook(() => useSavePhotoToDevice(), { wrapper });
    const vars = { slug: 'g', photoId: 801, filename: 'a.jpg' };

    let first = false;
    let second = true;
    let third = true;
    act(() => {
      first = grid.result.current.mutate(vars);
      second = grid.result.current.mutate(vars);
      third = lightbox.result.current.mutate(vars);
    });
    expect([first, second, third]).toEqual([true, false, false]);
    expect(isPhotoDownloadPending(801)).toBe(true);
    await waitFor(() => expect(svc.downloadPhoto).toHaveBeenCalledTimes(1));
    expect(svc.savePhotoToDevice).not.toHaveBeenCalled();

    // Another photo is not held up.
    act(() => { lightbox.result.current.mutate({ ...vars, photoId: 802 }); });
    await waitFor(() => expect(svc.savePhotoToDevice).toHaveBeenCalledTimes(1));

    await act(async () => { finish(); });
    await waitFor(() => expect(isPhotoDownloadPending(801)).toBe(false));
    let again = false;
    act(() => { again = grid.result.current.mutate(vars); });
    expect(again).toBe(true);
    await waitFor(() => expect(svc.downloadPhoto).toHaveBeenCalledTimes(2));
  });

  it('frees the photo when the download fails', async () => {
    svc.savePhotoToDevice.mockRejectedValueOnce(new Error('network'));
    const { result } = renderHook(() => useSavePhotoToDevice(), { wrapper });
    act(() => { result.current.mutate({ slug: 'g', photoId: 803, filename: 'b.jpg' }); });
    expect(isPhotoDownloadPending(803)).toBe(true);
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(isPhotoDownloadPending(803)).toBe(false);
  });

  it('keeps a slow download marked while it reports progress, and lets a silent one go', async () => {
    vi.useFakeTimers();
    try {
      let reportProgress!: () => void;
      svc.savePhotoToDevice.mockImplementationOnce((_slug: string, _id: number, _name: string, onProgress: () => void) => {
        reportProgress = onProgress;
        return new Promise(() => {});
      });
      const { result } = renderHook(() => useSavePhotoToDevice(), { wrapper });
      act(() => { result.current.mutate({ slug: 'g', photoId: 804, filename: 'c.jpg' }); });
      await act(() => vi.advanceTimersByTimeAsync(0));
      expect(reportProgress).toBeTypeOf('function');

      // A large original over a slow line: well past a minute, still arriving.
      for (let i = 0; i < 3; i += 1) {
        await act(() => vi.advanceTimersByTimeAsync(50_000));
        reportProgress();
      }
      expect(isPhotoDownloadPending(804)).toBe(true);
      let repeat = true;
      act(() => { repeat = result.current.mutate({ slug: 'g', photoId: 804, filename: 'c.jpg' }); });
      expect(repeat).toBe(false);

      // The bytes stop: a minute later the photo is free again.
      await act(() => vi.advanceTimersByTimeAsync(60_000));
      expect(isPhotoDownloadPending(804)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
