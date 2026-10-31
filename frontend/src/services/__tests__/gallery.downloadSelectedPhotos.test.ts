import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/api', () => ({ api: { post: vi.fn(), get: vi.fn() } }));
import { api } from '../../config/api';
import { galleryService } from '../gallery.service';
import { markGalleryLimited } from '../../utils/downloadLimit';

const ios = (enabled = true, ipad = false) => Object.defineProperties(navigator, {
  userAgent: { configurable: true, value: enabled && !ipad ? 'iPhone' : 'Macintosh' },
  platform: { configurable: true, value: 'MacIntel' },
  maxTouchPoints: { configurable: true, value: ipad ? 5 : 0 },
});

beforeEach(() => {
  vi.clearAllMocks();
  ios();
  markGalleryLimited('party', false);
  vi.spyOn(galleryService, 'fetchPhotoBlob').mockImplementation(async (_slug, id) => ({
    blob: new Blob([`image-${id}`], { type: 'image/jpeg' }), serverFilename: `camera-${id}.jpg`,
  }));
  Object.defineProperties(navigator, {
    canShare: { configurable: true, value: vi.fn(() => true) },
    share: { configurable: true, value: vi.fn(async () => undefined) },
  });
});
afterEach(() => vi.restoreAllMocks());

describe('small iOS selection sharing', () => {
  it('shares files with the server filenames and image types', async () => {
    expect(await galleryService.trySaveSelectedToDevice('party', [1, 2])).toBe('shared');
    expect(navigator.share).toHaveBeenCalledWith({ files: [
      expect.objectContaining({ name: 'camera-1.jpg', type: 'image/jpeg' }),
      expect.objectContaining({ name: 'camera-2.jpg', type: 'image/jpeg' }),
    ] });
    expect(api.post).not.toHaveBeenCalled();
  });
  it('supports iPadOS using its desktop user agent', async () => {
    ios(false, true);
    expect(await galleryService.trySaveSelectedToDevice('party', [1])).toBe('shared');
  });
  it('keeps dismissal distinct from a fallback', async () => {
    vi.mocked(navigator.share).mockRejectedValue(new DOMException('Cancelled', 'AbortError'));
    expect(await galleryService.trySaveSelectedToDevice('party', [1])).toBe('dismissed');
  });
  it.each(['desktop', 'large', 'limited', 'empty'])('does not fetch images for %s selections', async (mode) => {
    if (mode === 'desktop') ios(false);
    if (mode === 'limited') markGalleryLimited('party', true);
    const ids = mode === 'empty' ? [] : Array.from({ length: mode === 'large' ? 26 : 2 }, (_, i) => i + 1);
    expect(await galleryService.trySaveSelectedToDevice('party', ids)).toBe('fallback');
    expect(galleryService.fetchPhotoBlob).not.toHaveBeenCalled();
  });
  it('falls back after a missing capability, fetch error or unexpected share failure', async () => {
    vi.mocked(navigator.canShare).mockReturnValueOnce(false);
    expect(await galleryService.trySaveSelectedToDevice('party', [1])).toBe('fallback');
    vi.mocked(galleryService.fetchPhotoBlob).mockRejectedValueOnce(new Error('network'));
    expect(await galleryService.trySaveSelectedToDevice('party', [1])).toBe('fallback');
    vi.mocked(navigator.share).mockRejectedValueOnce(new Error('share'));
    expect(await galleryService.trySaveSelectedToDevice('party', [1])).toBe('fallback');
    expect(api.post).not.toHaveBeenCalled();
  });
});

describe('native archive transport', () => {
  it('preserves an explicitly empty selection so the server can refuse it', async () => {
    vi.mocked(api.post).mockResolvedValue({ data: { token: 'job', status: 'pending', resolution: 'original' } });
    await galleryService.startDownloadJob('party', undefined, []);
    expect(api.post).toHaveBeenCalledWith('/gallery/party/download-jobs', { photo_ids: [] });
  });
  it('passes gallery authentication through native URLs, including admin preview', () => {
    const links: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function () { links.push(this.href); });
    window.history.replaceState({}, '', '/gallery/party?admin_preview=1');
    galleryService.downloadCachedArchive('party');
    galleryService.downloadJobFile('party', 'job', { index: 1, total: 2 });
    galleryService.downloadJobFile('party', 'selected-job', undefined, true);
    expect(links.map((href) => new URL(href).pathname + new URL(href).search)).toEqual([
      '/api/gallery/party/download-all?admin_preview=1',
      '/api/gallery/party/download-jobs/job/file?part=1&parts=2&admin_preview=1',
      '/api/gallery/party/download-jobs/selected-job/file?selected=1&admin_preview=1',
    ]);
    expect(api.get).not.toHaveBeenCalled();
    window.history.replaceState({}, '', '/');
  });
});
