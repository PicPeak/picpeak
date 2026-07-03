/**
 * Coverage for #557 — iOS Web Share path on multi-photo selection.
 *
 * downloadSelectedPhotos historically POSTed to /download-selected and
 * triggered a zip download. On iOS with a small selection it now routes
 * through navigator.share({ files }) so the photos land in Photos via
 * the share sheet's "Save N Images" action. Above the file-count cap
 * or anywhere off-iOS, behaviour is unchanged.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const IOS_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15';
const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/120.0.0.0';

const fetchedFor = (id: number) => ({
  blob: new Blob([`photo-${id}`], { type: 'image/jpeg' }),
  serverFilename: `IMG_${String(id).padStart(4, '0')}.jpg`,
});

// Mock the axios layer so the test never makes a network call. The
// real api.post resolves with { data: Blob } for the zip path; the
// shape only matters when the fallback branch is exercised.
vi.mock('../../config/api', () => ({
  api: {
    post: vi.fn(),
    get: vi.fn(),
  },
}));

let galleryService: typeof import('../gallery.service').galleryService;
let apiMock: { post: ReturnType<typeof vi.fn>; get: ReturnType<typeof vi.fn> };

const installNavigator = (overrides: Partial<{
  userAgent: string;
  platform: string;
  maxTouchPoints: number;
  share: ReturnType<typeof vi.fn>;
  canShare: ReturnType<typeof vi.fn>;
}>) => {
  const desc = (value: any) => ({ value, configurable: true, writable: true });
  Object.defineProperties(navigator, {
    userAgent: desc(overrides.userAgent ?? ''),
    platform: desc(overrides.platform ?? ''),
    maxTouchPoints: desc(overrides.maxTouchPoints ?? 0),
  });
  (navigator as any).share = overrides.share;
  (navigator as any).canShare = overrides.canShare;
};

describe('galleryService.downloadSelectedPhotos — iOS Web Share path (#557)', () => {
  beforeEach(async () => {
    vi.resetModules();
    const services = await import('../gallery.service');
    galleryService = services.galleryService;
    apiMock = (await import('../../config/api')).api as any;
    apiMock.post.mockReset();
    apiMock.post.mockResolvedValue({ data: new Blob(['zip-bytes'], { type: 'application/zip' }) });

    // jsdom doesn't ship URL.createObjectURL / revokeObjectURL —
    // the zip-fallback path needs both to materialise the <a> link.
    (window.URL.createObjectURL as any) = vi.fn(() => 'blob:fake');
    (window.URL.revokeObjectURL as any) = vi.fn();

    // fetchPhotoBlob is the network-dependent helper; stub it across
    // every test so we never touch the real download endpoint.
    vi.spyOn(galleryService, 'fetchPhotoBlob').mockImplementation((_slug, id) =>
      Promise.resolve(fetchedFor(id) as any),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete (navigator as any).share;
    delete (navigator as any).canShare;
  });

  it('routes through navigator.share on iOS with a small selection', async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    const canShare = vi.fn().mockReturnValue(true);
    installNavigator({ userAgent: IOS_UA, share, canShare });

    await galleryService.downloadSelectedPhotos('wedding-2026', [1, 2, 3]);

    expect(share).toHaveBeenCalledTimes(1);
    const shareArg = share.mock.calls[0][0];
    expect(shareArg.files).toHaveLength(3);
    expect((shareArg.files[0] as File).name).toBe('IMG_0001.jpg');
    // Zip endpoint must NOT be called when share succeeds.
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it('falls back to the zip endpoint on Android, even with canShare available', async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    const canShare = vi.fn().mockReturnValue(true);
    installNavigator({ userAgent: ANDROID_UA, share, canShare });

    await galleryService.downloadSelectedPhotos('wedding-2026', [1, 2, 3]);

    expect(share).not.toHaveBeenCalled();
    expect(apiMock.post).toHaveBeenCalledTimes(1);
    expect(apiMock.post).toHaveBeenCalledWith(
      '/gallery/wedding-2026/download-selected',
      { photo_ids: [1, 2, 3] },
      { responseType: 'blob' },
    );
  });

  it('falls back to the zip endpoint above the 25-file cap', async () => {
    // 26 photos: even on iOS, this exceeds MAX_WEB_SHARE_FILES so the
    // Web Share path is skipped entirely (no fetchPhotoBlob calls,
    // no share() call, no canShare() probe).
    const share = vi.fn();
    const canShare = vi.fn();
    installNavigator({ userAgent: IOS_UA, share, canShare });

    const ids = Array.from({ length: 26 }, (_, i) => i + 1);
    await galleryService.downloadSelectedPhotos('wedding-2026', ids);

    expect(galleryService.fetchPhotoBlob).not.toHaveBeenCalled();
    expect(share).not.toHaveBeenCalled();
    expect(apiMock.post).toHaveBeenCalledTimes(1);
  });

  it('takes the Web Share path at exactly the 25-file boundary', async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    const canShare = vi.fn().mockReturnValue(true);
    installNavigator({ userAgent: IOS_UA, share, canShare });

    const ids = Array.from({ length: 25 }, (_, i) => i + 1);
    await galleryService.downloadSelectedPhotos('wedding-2026', ids);

    expect(share).toHaveBeenCalledTimes(1);
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it('does NOT fall back to the zip endpoint when the user dismisses the share sheet (AbortError)', async () => {
    const abortErr = Object.assign(new Error('user dismissed'), { name: 'AbortError' });
    const share = vi.fn().mockRejectedValue(abortErr);
    const canShare = vi.fn().mockReturnValue(true);
    installNavigator({ userAgent: IOS_UA, share, canShare });

    await galleryService.downloadSelectedPhotos('wedding-2026', [1, 2, 3]);

    expect(share).toHaveBeenCalledTimes(1);
    // A surprise zip in Downloads would defeat the user's deliberate
    // dismissal of the share sheet.
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it('falls back to the zip endpoint when share() rejects with a non-Abort error', async () => {
    const notAllowed = Object.assign(new Error('blocked'), { name: 'NotAllowedError' });
    const share = vi.fn().mockRejectedValue(notAllowed);
    const canShare = vi.fn().mockReturnValue(true);
    installNavigator({ userAgent: IOS_UA, share, canShare });

    await galleryService.downloadSelectedPhotos('wedding-2026', [1, 2, 3]);

    expect(apiMock.post).toHaveBeenCalledTimes(1);
  });

  it('falls back to the zip endpoint when canShare({files}) returns false (older iOS)', async () => {
    const share = vi.fn();
    const canShare = vi.fn().mockReturnValue(false);
    installNavigator({ userAgent: IOS_UA, share, canShare });

    await galleryService.downloadSelectedPhotos('wedding-2026', [1, 2, 3]);

    expect(share).not.toHaveBeenCalled();
    expect(apiMock.post).toHaveBeenCalledTimes(1);
  });

  it('falls back to the zip endpoint when any photo fetch fails (partial shares would be confusing)', async () => {
    const share = vi.fn();
    const canShare = vi.fn().mockReturnValue(true);
    installNavigator({ userAgent: IOS_UA, share, canShare });

    // Re-stub fetchPhotoBlob so the 2nd of 3 photos fails — the Promise.all
    // collapse must route the whole batch to the zip endpoint rather
    // than sharing only the photos that resolved.
    (galleryService.fetchPhotoBlob as any).mockReset();
    (galleryService.fetchPhotoBlob as any)
      .mockResolvedValueOnce(fetchedFor(1))
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce(fetchedFor(3));

    await galleryService.downloadSelectedPhotos('wedding-2026', [1, 2, 3]);

    expect(share).not.toHaveBeenCalled();
    expect(apiMock.post).toHaveBeenCalledTimes(1);
  });

  it('falls back to the zip endpoint when the selection is empty (no Web Share invocation)', async () => {
    const share = vi.fn();
    const canShare = vi.fn();
    installNavigator({ userAgent: IOS_UA, share, canShare });

    await galleryService.downloadSelectedPhotos('wedding-2026', []);

    expect(galleryService.fetchPhotoBlob).not.toHaveBeenCalled();
    expect(share).not.toHaveBeenCalled();
    expect(apiMock.post).toHaveBeenCalledTimes(1);
  });
});
