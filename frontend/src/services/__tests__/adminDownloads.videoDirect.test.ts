/**
 * Issue 2277: an admin video download navigates straight at the download
 * route, so the browser streams it instead of axios buffering the whole file
 * as a blob. Photos keep the fetch path.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/api', () => ({
  api: {
    get: vi.fn(),
    head: vi.fn(async () => ({})),
    getUri: vi.fn(({ url }: { url: string }) => `/api${url}`),
  },
}));

import { api } from '../../config/api';
import { photosService } from '../photos.service';

const apiMock = api as unknown as { get: ReturnType<typeof vi.fn>; getUri: ReturnType<typeof vi.fn> };

describe('photosService.downloadPhoto — videos (issue 2277)', () => {
  let clicked: HTMLAnchorElement[];

  beforeEach(() => {
    apiMock.get.mockReset();
    clicked = [];
    (window.URL.createObjectURL as any) = vi.fn(() => 'blob:fake');
    (window.URL.revokeObjectURL as any) = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push(this);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('navigates a video straight at the admin download route', async () => {
    await photosService.downloadPhoto(3, 11, 'clip.mp4', true);

    expect(apiMock.get).not.toHaveBeenCalled();
    expect(window.URL.createObjectURL).not.toHaveBeenCalled();
    expect(clicked).toHaveLength(1);
    expect(clicked[0].getAttribute('href')).toBe('/api/admin/events/3/photos/11/download');
    expect(clicked[0].getAttribute('download')).toBe('clip.mp4');
    // The anchor does not linger in the document.
    expect(document.querySelector('a[download]')).toBeNull();
  });

  it('keeps fetching a photo as a blob', async () => {
    apiMock.get.mockResolvedValue({
      data: new Blob(['jpeg'], { type: 'image/jpeg' }),
      headers: { 'content-disposition': 'attachment; filename="IMG_0011.jpg"' },
    });

    await photosService.downloadPhoto(3, 11, 'fallback.jpg');

    expect(apiMock.get).toHaveBeenCalledWith('/admin/events/3/photos/11/download', { responseType: 'blob' });
    expect(clicked).toHaveLength(1);
    expect(clicked[0].getAttribute('href')).toBe('blob:fake');
    expect(clicked[0].download).toBe('IMG_0011.jpg');
  });
});
