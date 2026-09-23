/**
 * Download limit (issue 1560) — the transports.
 *
 *  - a refused single download must not fall back to the view endpoint,
 *    which would hand over the preview as if it were the download
 *  - a limited gallery fetches single downloads instead of navigating, so a
 *    refusal reaches the page instead of landing as a broken file
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/api', () => ({
  api: { get: vi.fn(), post: vi.fn(), getUri: vi.fn(({ url }: { url: string }) => `/api${url}`) },
}));
vi.mock('react-toastify', () => ({ toast: { error: vi.fn() } }));

const DESKTOP_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15';

const refusal = () => ({
  response: {
    status: 403,
    data: new Blob([JSON.stringify({ code: 'DOWNLOAD_LIMIT_REACHED', limit: 1, used: 1, remaining: 0 })]),
  },
});

let galleryService: typeof import('../gallery.service').galleryService;
let limit: typeof import('../../utils/downloadLimit');
let apiMock: { get: ReturnType<typeof vi.fn> };

describe('gallery downloads under a download limit (issue 1560)', () => {
  beforeEach(async () => {
    vi.resetModules();
    galleryService = (await import('../gallery.service')).galleryService;
    limit = await import('../../utils/downloadLimit');
    apiMock = (await import('../../config/api')).api as any;
    apiMock.get.mockReset();
    Object.defineProperty(navigator, 'userAgent', { value: DESKTOP_UA, configurable: true });
    Object.defineProperty(navigator, 'platform', { value: 'MacIntel', configurable: true });
    Object.defineProperty(navigator, 'maxTouchPoints', { value: 0, configurable: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not fall back to the view endpoint when the download was refused', async () => {
    apiMock.get.mockRejectedValueOnce(refusal());
    await expect(galleryService.fetchPhotoBlob('g', 7)).rejects.toBeTruthy();
    expect(apiMock.get).toHaveBeenCalledTimes(1);
    expect(apiMock.get.mock.calls[0][0]).toBe('/gallery/g/download/7');
  });

  it('still falls back to the view endpoint for other failures', async () => {
    apiMock.get
      .mockRejectedValueOnce({ response: { status: 404, data: null } })
      .mockResolvedValueOnce({ data: new Blob(['x']), headers: {} });
    await galleryService.fetchPhotoBlob('g', 7);
    expect(apiMock.get.mock.calls[1][0]).toBe('/gallery/g/photo/7');
  });

  it('fetches instead of navigating on a limited gallery, and surfaces the refusal', async () => {
    const navigate = vi.spyOn(galleryService, 'triggerDirectDownload').mockImplementation(() => undefined);
    limit.markGalleryLimited('g', true);
    apiMock.get.mockRejectedValueOnce(refusal());

    await expect(galleryService.savePhotoToDevice('g', 7, 'x.jpg'))
      .rejects.toBeInstanceOf(limit.DownloadLimitError);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('keeps navigating straight to the file on an unlimited gallery', async () => {
    const navigate = vi.spyOn(galleryService, 'triggerDirectDownload').mockImplementation(() => undefined);
    limit.markGalleryLimited('g', false);
    await galleryService.savePhotoToDevice('g', 7, 'x.jpg');
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(apiMock.get).not.toHaveBeenCalled();
  });
});
