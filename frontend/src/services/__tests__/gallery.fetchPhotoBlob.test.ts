/**
 * fetchPhotoBlob's fallback to `/photo/:photoId` exists for exactly one case:
 * the original file is gone and only a derivative remains (a 404 from
 * `/download/:photoId`). Any other status is a refusal the caller must see
 * (fork survey A4 / #1563).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/api', () => ({
  api: {
    get: vi.fn(),
  },
}));

let galleryService: typeof import('../gallery.service').galleryService;
let apiMock: { get: ReturnType<typeof vi.fn> };

const axiosError = (status: number, data: unknown = {}) =>
  Object.assign(new Error(`request failed with status ${status}`), {
    response: { status, data },
  });

describe('galleryService.fetchPhotoBlob — fallback only on a genuine 404', () => {
  beforeEach(async () => {
    vi.resetModules();
    galleryService = (await import('../gallery.service')).galleryService;
    apiMock = (await import('../../config/api')).api as any;
    apiMock.get.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('falls back to /photo/:id when /download/:id 404s (original missing)', async () => {
    apiMock.get
      .mockRejectedValueOnce(axiosError(404, { error: 'Photo file not found' }))
      .mockResolvedValueOnce({
        data: new Blob(['derivative']),
        headers: {},
      });

    const result = await galleryService.fetchPhotoBlob('wedding-2026', 5);

    expect(apiMock.get).toHaveBeenCalledTimes(2);
    expect(apiMock.get).toHaveBeenNthCalledWith(
      1,
      '/gallery/wedding-2026/download/5',
      expect.objectContaining({ responseType: 'blob' }),
    );
    expect(apiMock.get).toHaveBeenNthCalledWith(
      2,
      '/gallery/wedding-2026/photo/5',
      expect.objectContaining({ responseType: 'blob' }),
    );
    expect(result.blob).toBeInstanceOf(Blob);
  });

  it('rethrows a 403 instead of falling back', async () => {
    apiMock.get.mockRejectedValueOnce(
      axiosError(403, { error: 'Downloads are disabled for this gallery' }),
    );

    await expect(galleryService.fetchPhotoBlob('wedding-2026', 5)).rejects.toMatchObject({
      response: { status: 403 },
    });
    expect(apiMock.get).toHaveBeenCalledTimes(1);
  });

  it('rethrows a 429 instead of falling back', async () => {
    apiMock.get.mockRejectedValueOnce(axiosError(429, { error: 'Too many requests' }));

    await expect(galleryService.fetchPhotoBlob('wedding-2026', 5)).rejects.toMatchObject({
      response: { status: 429 },
    });
    expect(apiMock.get).toHaveBeenCalledTimes(1);
  });

  it('rethrows a 500 instead of masking an operational failure as a fallback', async () => {
    apiMock.get.mockRejectedValueOnce(axiosError(500, { error: 'Failed to download photo' }));

    await expect(galleryService.fetchPhotoBlob('wedding-2026', 5)).rejects.toMatchObject({
      response: { status: 500 },
    });
    expect(apiMock.get).toHaveBeenCalledTimes(1);
  });
});
