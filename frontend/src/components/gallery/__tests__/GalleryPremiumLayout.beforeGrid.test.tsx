/**
 * The row above the photos (`beforeGrid`, issue 2355): Premium puts it at the
 * top of its main column, below the hero and the sticky nav, so it shares the
 * grid's side padding; an empty result keeps it so the filter can be cleared.
 */
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import type { Photo } from '../../../types';

vi.mock('../../../hooks/usePublicSettings', () => ({ usePublicSettings: () => ({ data: undefined }) }));
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

afterEach(() => cleanup());

const row = <button type="button">Find my photos with a selfie</button>;

describe('Gallery Premium row above the photos', () => {
  it('renders it first in the main column, after the hero and the nav', () => {
    const { container } = mount({ beforeGrid: row });
    const toolbar = container.querySelector('.gallery-premium-main > .gallery-premium-toolbar:first-child');
    expect(toolbar).not.toBeNull();
    expect(within(toolbar as HTMLElement).getByRole('button', { name: 'Find my photos with a selfie' })).toBeTruthy();
    expect(container.querySelector('.gallery-premium-nav .gallery-premium-toolbar')).toBeNull();
  });

  it('keeps it when the filter leaves no photos', () => {
    const { container } = mount({ photos: [], beforeGrid: row });
    expect(container.querySelector('.gallery-premium-toolbar--empty')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Find my photos with a selfie' })).toBeTruthy();
  });

  it('renders no row without one', () => {
    const { container } = mount();
    expect(container.querySelector('.gallery-premium-toolbar')).toBeNull();
  });
});
