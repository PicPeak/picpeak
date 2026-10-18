/**
 * Admin downloads hand the browser the blob axios returned, so the server's
 * Content-Type survives. A re-wrapped blob has no type, and browsers that
 * name a blob download from its type save it as .bin (issue 2175).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/api', () => ({
  api: {
    post: vi.fn(),
    get: vi.fn(),
  },
}));

import { api } from '../../config/api';
import { archiveService } from '../archive.service';
import { photosService } from '../photos.service';

const apiMock = api as unknown as { get: ReturnType<typeof vi.fn>; post: ReturnType<typeof vi.fn> };

const savedType = () => ((window.URL.createObjectURL as any).mock.calls[0][0] as Blob).type;

describe('admin downloads keep the server type', () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    apiMock.post.mockReset();
    (window.URL.createObjectURL as any) = vi.fn(() => 'blob:fake');
    (window.URL.revokeObjectURL as any) = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('archive download', async () => {
    apiMock.get.mockResolvedValue({ data: new Blob(['zip'], { type: 'application/zip' }), headers: {} });

    await archiveService.downloadArchive(7, 'wedding.zip');

    expect(savedType()).toBe('application/zip');
  });

  it('photo download', async () => {
    apiMock.get.mockResolvedValue({ data: new Blob(['jpeg'], { type: 'image/jpeg' }), headers: {} });

    await photosService.downloadPhoto(3, 11, 'IMG_0011.jpg');

    expect(savedType()).toBe('image/jpeg');
  });

  it('photo export', async () => {
    apiMock.post.mockResolvedValue({
      data: new Blob(['csv'], { type: 'text/csv' }),
      headers: { 'content-disposition': 'attachment; filename="export.csv"' },
    });

    await photosService.exportPhotos(3, {} as any);

    expect(savedType()).toBe('text/csv');
  });
});
