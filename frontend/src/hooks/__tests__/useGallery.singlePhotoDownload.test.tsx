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

import { toast } from 'react-toastify';
import { useDownloadPhoto, useSavePhotoToDevice } from '../useGallery';
import { isPhotoDownloadPending } from '../usePhotoDownloadPending';
import { markGalleryLimited } from '../../utils/downloadLimit';

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

  // Issue 2263: a video in a gallery without a limit downloads directly, so
  // the call returns before any byte arrives; only a fetched download toasts.
  it('toasts a fetched download, not a direct video download', async () => {
    svc.downloadPhoto.mockResolvedValue(undefined);
    const { result } = renderHook(() => useDownloadPhoto(), { wrapper });
    vi.mocked(toast.success).mockClear();

    act(() => { result.current.mutate({ slug: 'open', photoId: 811, filename: 'v.mp4', isVideo: true }); });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(toast.success).not.toHaveBeenCalled();

    markGalleryLimited('capped', true);
    try {
      act(() => { result.current.mutate({ slug: 'capped', photoId: 812, filename: 'w.mp4', isVideo: true }); });
      await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(1));
      act(() => { result.current.mutate({ slug: 'open', photoId: 813, filename: 'p.jpg' }); });
      await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(2));
    } finally {
      markGalleryLimited('capped', false);
    }
  });
});
