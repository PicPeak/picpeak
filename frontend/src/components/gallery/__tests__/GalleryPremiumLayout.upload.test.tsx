/**
 * Guest upload in the Gallery Premium layout. It renders no gallery header,
 * the only place the other layouts offer the upload button, so its sticky nav
 * carries it — and the empty state too, since an upload-only gallery starts
 * empty.
 */
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { Photo } from '../../../types';

vi.mock('react-i18next', async () => ({
  ...await vi.importActual('react-i18next'),
  useTranslation: () => ({
    t: (key: string, fallback?: unknown) => (typeof fallback === 'string' ? fallback : key),
    i18n: { language: 'en' },
  }),
}));
vi.mock('../../../hooks/useGallery', () => ({ useDownloadPhoto: () => ({ mutate: vi.fn() }) }));
vi.mock('../../../contexts/GuestIdentityContext', () => ({ useGuestIdentityOptional: () => null }));
vi.mock('../../../hooks/useInputMode', () => ({ useInputMode: () => 'mouse' }));
vi.mock('react-intersection-observer', () => ({ useInView: () => ({ ref: vi.fn(), inView: true }) }));
vi.mock('../../../services/gallery.service', () => ({ galleryService: { trackPhotoView: vi.fn() } }));
vi.mock('../../common', async () => ({ ...await vi.importActual('../../common'), PoweredBy: () => null }));
vi.mock('react-photo-album', () => ({
  MasonryPhotoAlbum: ({ photos, render: renderer }: any) => <>{photos.map((photo: any, index: number) =>
    <React.Fragment key={photo.key}>{renderer.photo({}, { photo, index, width: 300, height: 200 })}</React.Fragment>
  )}</>,
}));
vi.mock('yet-another-react-lightbox', () => ({ default: () => null }));
vi.mock('yet-another-react-lightbox/plugins/thumbnails', () => ({ default: () => null }));
vi.mock('yet-another-react-lightbox/plugins/zoom', () => ({ default: () => null }));
vi.mock('yet-another-react-lightbox/plugins/fullscreen', () => ({ default: () => null }));
vi.mock('yet-another-react-lightbox/plugins/download', () => ({ default: () => null }));
vi.mock('yet-another-react-lightbox/plugins/captions', () => ({ default: () => null }));

import { GalleryPremiumLayout } from '../layouts/GalleryPremiumLayout';

const photos = [1, 2].map((id) => ({
  id, filename: `photo-${id}.jpg`,
  url: `/api/gallery/demo/photo/${id}`, thumbnail_url: `/api/gallery/demo/thumbnail/${id}`,
  width: 6000, height: 4000, type: 'individual', size: 1, uploaded_at: '2026-01-01T00:00:00Z',
})) as Photo[];

const mount = (props: Record<string, unknown> = {}) => render(
  <GalleryPremiumLayout photos={photos} slug="demo" onPhotoClick={vi.fn()} onDownload={vi.fn()} {...props} />
);

const nav = (container: HTMLElement) => within(container.querySelector('.gallery-premium-nav') as HTMLElement);

afterEach(() => cleanup());

describe('Gallery Premium guest upload', () => {
  it('has no upload button when uploads are off', () => {
    const { container } = mount();
    expect(nav(container).queryByRole('button', { name: 'Upload Photos' })).toBeNull();
  });

  it('puts a labelled upload button in the nav that opens the dialog', () => {
    const onUploadClick = vi.fn();
    const { container } = mount({ onUploadClick });
    const button = nav(container).getByRole('button', { name: 'Upload Photos' });
    expect(button).toHaveAttribute('title', 'Upload Photos');
    expect(button).toHaveClass('gallery-premium-nav-btn');
    fireEvent.click(button);
    expect(onUploadClick).toHaveBeenCalledTimes(1);
  });

  it('gives the row to the selection controls while photos are selected', () => {
    const { container } = mount({ onUploadClick: vi.fn(), isSelectionMode: true, selectedPhotos: new Set([1]) });
    expect(nav(container).queryByRole('button', { name: 'Upload Photos' })).toBeNull();
  });

  it('offers the upload in an empty gallery, which has no nav', () => {
    const onUploadClick = vi.fn();
    const { container } = mount({ photos: [], onUploadClick });
    expect(container.querySelector('.gallery-premium-nav')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Upload Photos' }));
    expect(onUploadClick).toHaveBeenCalledTimes(1);
  });

  it('shows no upload in an empty gallery when uploads are off', () => {
    mount({ photos: [] });
    expect(screen.queryByRole('button', { name: 'Upload Photos' })).toBeNull();
  });
});
