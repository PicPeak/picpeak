/**
 * Download menu (issue 1733, E2): a size the guest picked for one photo
 * reaches the download route as `?resolution=`, on both the direct-link and
 * the fetched path; without a pick the URL stays as it was, so the server
 * hands out the gallery's standard size.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let galleryService: typeof import('../gallery.service').galleryService;
let api: typeof import('../../config/api').api;

const DESKTOP_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15';

describe('single-photo download with a picked resolution', () => {
  beforeEach(async () => {
    vi.resetModules();
    Object.defineProperty(navigator, 'userAgent', { value: DESKTOP_UA, configurable: true });
    galleryService = (await import('../gallery.service')).galleryService;
    api = (await import('../../config/api')).api;
    vi.spyOn(galleryService, 'triggerDirectDownload').mockImplementation(() => undefined);
    vi.spyOn(galleryService, 'triggerBrowserDownload').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('puts the picked size on the direct download link', async () => {
    await galleryService.savePhotoToDevice('party', 7, 'a.jpg', undefined, '1500x1000');
    const [href] = vi.mocked(galleryService.triggerDirectDownload).mock.calls[0];
    expect(href).toMatch(/\/gallery\/party\/download\/7\?resolution=1500x1000$/);
  });

  it('leaves the link alone without a pick', async () => {
    await galleryService.savePhotoToDevice('party', 7, 'a.jpg');
    const [href] = vi.mocked(galleryService.triggerDirectDownload).mock.calls[0];
    expect(href).toMatch(/\/gallery\/party\/download\/7$/);
  });

  it('sends the picked size when the photo is fetched', async () => {
    const get = vi.spyOn(api, 'get').mockResolvedValue({ data: new Blob(['x']), headers: {} });
    await galleryService.downloadPhoto('party', 7, 'a.jpg', undefined, '800x600');
    expect(get).toHaveBeenCalledWith('/gallery/party/download/7', expect.objectContaining({
      params: { resolution: '800x600' },
    }));
  });
});
