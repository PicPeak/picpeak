import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { GalleryPremiumLayout } from '../layouts/GalleryPremiumLayout';
import { galleryService } from '../../../services/gallery.service';
import type { Photo } from '../../../types';

const { download } = vi.hoisted(() => ({ download: vi.fn() }));
vi.mock('react-i18next', async () => ({
  ...await vi.importActual('react-i18next'),
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('../../../hooks/useGallery', () => ({ useDownloadPhoto: () => ({ mutate: download }) }));
vi.mock('../../../contexts/GuestIdentityContext', () => ({ useGuestIdentityOptional: () => null }));
vi.mock('../../../hooks/useInputMode', () => ({ useInputMode: () => 'mouse' }));
vi.mock('react-intersection-observer', () => ({ useInView: () => ({ ref: vi.fn(), inView: true }) }));
vi.mock('../../../services/gallery.service', () => ({ galleryService: { trackPhotoView: vi.fn() } }));
vi.mock('../../common', async () => ({
  ...await vi.importActual('../../common'),
  PoweredBy: () => null,
}));
// Only stub the masonry geometry. Both YARL (including Zoom/Thumbnails) and
// AuthenticatedImage are real, so opening a tile exercises the integration.
vi.mock('react-photo-album', () => ({
  MasonryPhotoAlbum: ({ photos, render: renderer }: any) => <>{photos.map((photo: any) =>
    <React.Fragment key={photo.key}>{renderer.photo({}, { photo, width: 300, height: 200 })}</React.Fragment>
  )}</>,
}));

const photos = [1, 2, 3].map((id) => ({
  id, filename: `photo-${id}.jpg`, original_filename: `original-${id}.jpg`,
  url: `/api/gallery/demo/photo/${id}`,
  preview_url: `/api/gallery/demo/preview/${id}`,
  thumbnail_url: `/api/gallery/demo/thumbnail/${id}`,
  width: 6000, height: 4000, type: 'individual', size: 1,
  uploaded_at: '2026-01-01T00:00:00Z',
})) as Photo[];

const decoded: HTMLImageElement[] = [];
const drawImage = vi.fn();
const revokeObjectURL = vi.fn();
const fetchImage = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  decoded.length = 0;
  sessionStorage.setItem('gallery_token_demo', 'gallery-test-token');
  fetchImage.mockResolvedValue({ ok: true, blob: async () => new Blob(['image']) });
  vi.stubGlobal('fetch', fetchImage);
  let sequence = 0;
  vi.stubGlobal('URL', class extends URL {
    static createObjectURL = () => `blob:premium-${++sequence}`;
    static revokeObjectURL = revokeObjectURL;
  });
  const RealImage = Image;
  vi.stubGlobal('Image', class extends RealImage {
    constructor() {
      super();
      decoded.push(this);
      Object.defineProperties(this, {
        complete: { value: true },
        naturalWidth: { value: 1600 },
        naturalHeight: { value: 1000 },
      });
      setTimeout(() => this.onload?.(new Event('load')), 0);
    }
  });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(960);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(640);
});

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function mount(props: Partial<React.ComponentProps<typeof GalleryPremiumLayout>> = {}) {
  return render(<GalleryPremiumLayout
    photos={photos} slug="demo" onPhotoClick={vi.fn()} onDownload={vi.fn()}
    allowDownloads={false} {...props}
  />);
}

async function openPhoto() {
  fireEvent.click(screen.getByTestId('photo-card-1'));
  return screen.findByRole('dialog');
}

async function readyCanvas(dialog: HTMLElement, id = 1) {
  await waitFor(() => {
    const canvas = dialog.querySelector(`canvas[aria-label="photo-${id}.jpg"]`);
    expect(canvas).toHaveStyle({ opacity: '1' });
  });
  return dialog.querySelector(`canvas[aria-label="photo-${id}.jpg"]`) as HTMLCanvasElement;
}

describe('Premium lightbox canvas rendering (#1325)', () => {
  it.each([
    { useCanvasRendering: true, protectionLevel: 'standard' as const },
    { useCanvasRendering: false, protectionLevel: 'maximum' as const },
  ])('uses canvas only for the active photo: %j', async (options) => {
    mount(options);
    expect(document.querySelector('canvas')).toBeNull();
    const dialog = await openPhoto();
    const canvas = await readyCanvas(dialog);
    expect(canvas.width).toBe(1600);
    expect(document.querySelectorAll('canvas')).toHaveLength(1);
    expect(dialog.querySelectorAll('.yarl__slide img').length).toBeGreaterThan(0);
    expect(dialog.querySelector('.yarl__thumbnails_container canvas')).toBeNull();
    expect(fetchImage).toHaveBeenCalledWith(expect.stringContaining('/preview/1'), expect.objectContaining({
      credentials: 'include', headers: { Authorization: 'Bearer gallery-test-token' },
    }));
    expect(galleryService.trackPhotoView).toHaveBeenCalledWith('demo', 1);
  });

  it.each(['basic', 'standard', 'enhanced'] as const)('uses an image with %s protection and canvas off', async (protectionLevel) => {
    mount({ protectionLevel, useCanvasRendering: false });
    const dialog = await openPhoto();
    expect(dialog.querySelector('canvas')).toBeNull();
    expect(dialog.querySelector('.yarl__slide_current img')).not.toBeNull();
  });

  it('releases canvases and blob URLs on navigation and close', async () => {
    mount({ useCanvasRendering: true });
    const dialog = await openPhoto();
    const first = await readyCanvas(dialog);
    const firstBlob = decoded[0].src; // The detached source has already been released.
    expect(firstBlob).toBe('');
    const revokedBefore = revokeObjectURL.mock.calls.length;
    fireEvent.click(within(dialog).getByRole('button', { name: 'Next' }));
    const second = await readyCanvas(dialog, 2);
    expect(first.width).toBe(0);
    expect(first.height).toBe(0);
    expect(document.querySelectorAll('canvas')).toHaveLength(1);
    expect(revokeObjectURL.mock.calls.length).toBeGreaterThan(revokedBefore);
    expect(galleryService.trackPhotoView).toHaveBeenLastCalledWith('demo', 2);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(second.width).toBe(0);
    expect(second.height).toBe(0);
    expect(document.querySelector('canvas')).toBeNull();
  });

  it('keeps zoom bounded by the loaded preview without decoding again', async () => {
    mount({ useCanvasRendering: true });
    const dialog = await openPhoto();
    const canvas = await readyCanvas(dialog);
    const decodeCount = decoded.length;
    fireEvent.click(within(dialog).getByRole('button', { name: 'Zoom in' }));
    // 1600px preview / (960px viewport - 2 * 16px carousel padding).
    await waitFor(() => expect(canvas.parentElement?.style.transform).toContain('scale(1.72414)'));
    expect(decoded).toHaveLength(decodeCount);
    expect(within(dialog).getByRole('button', { name: 'Zoom in' })).toBeDisabled();
  });

  it('loads the thumbnail fallback with gallery authentication', async () => {
    fetchImage.mockImplementation(async (url: string) => url.includes('/preview/1')
      ? { ok: false, status: 404, statusText: 'Not Found' }
      : { ok: true, blob: async () => new Blob(['image']) });
    mount({ useCanvasRendering: true });
    const dialog = await openPhoto();
    await readyCanvas(dialog);
    expect(fetchImage).toHaveBeenLastCalledWith(expect.stringContaining('/api/gallery/demo/thumbnail/1'), expect.objectContaining({
      headers: { Authorization: 'Bearer gallery-test-token' },
    }));
  });

  it('preserves captions and downloads the current photo after navigation', async () => {
    mount({ useCanvasRendering: true, allowDownloads: true, showOriginalFilename: true });
    const dialog = await openPhoto();
    await readyCanvas(dialog);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Next' }));
    await readyCanvas(dialog, 2);
    expect(within(dialog).getByText('original-2.jpg')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Download' }));
    expect(download).toHaveBeenCalledWith({ slug: 'demo', photoId: 2, filename: 'photo-2.jpg' });
  });
});
