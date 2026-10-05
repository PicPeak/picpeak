/**
 * Gallery Premium owns its lightbox. When the photo it is on leaves
 * `photos` while others remain (a filter change), the slide at the old
 * index is a different photo and YARL fires no `view` for it, so without
 * this the URL kept the old `?photo=`. The layout clamps onto a neighbour
 * and reports the step; with no slides left it closes and reports that.
 */
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Photo } from '../../../types';

vi.mock('react-i18next', async () => ({
  ...await vi.importActual('react-i18next'),
  useTranslation: () => ({ t: (key: string) => key }),
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
// A controlled stand-in for YARL: shows the index it is given, fires no view.
vi.mock('yet-another-react-lightbox', () => ({
  default: ({ open, index }: { open: boolean; index: number }) => (open ? <div data-testid="yarl" data-index={index} /> : null),
}));
vi.mock('yet-another-react-lightbox/plugins/thumbnails', () => ({ default: () => null }));
vi.mock('yet-another-react-lightbox/plugins/zoom', () => ({ default: () => null }));
vi.mock('yet-another-react-lightbox/plugins/fullscreen', () => ({ default: () => null }));
vi.mock('yet-another-react-lightbox/plugins/download', () => ({ default: () => null }));
vi.mock('yet-another-react-lightbox/plugins/captions', () => ({ default: () => null }));

import { GalleryPremiumLayout } from '../layouts/GalleryPremiumLayout';

const photos = [1, 2, 3].map((id) => ({
  id, filename: `photo-${id}.jpg`, original_filename: `original-${id}.jpg`,
  url: `/api/gallery/demo/photo/${id}`, thumbnail_url: `/api/gallery/demo/thumbnail/${id}`,
  width: 6000, height: 4000, type: 'individual', size: 1, uploaded_at: '2026-01-01T00:00:00Z',
})) as Photo[];

// `openPhotoId` mirrors what the container reads back from the URL after
// the layout reported an open, as GalleryView does.
const mount = (list: Photo[], onChange: ReturnType<typeof vi.fn>, openPhotoId: number | null = null) => (
  <GalleryPremiumLayout photos={list} slug="demo" onPhotoClick={vi.fn()} onDownload={vi.fn()} allowDownloads={false}
    openPhotoId={openPhotoId} onLightboxPhotoChange={onChange} />
);

afterEach(() => cleanup());

describe('Gallery Premium — the open photo leaves the list', () => {
  it('clamps onto a neighbour and reports the step', () => {
    const onChange = vi.fn();
    const { rerender } = render(mount(photos, onChange));
    fireEvent.click(screen.getByTestId('photo-card-2'));
    expect(onChange).toHaveBeenLastCalledWith(2, 'open');
    expect(screen.getByTestId('yarl').dataset.index).toBe('1');

    rerender(mount(photos.filter((p) => p.id !== 2), onChange, 2));
    expect(onChange).toHaveBeenLastCalledWith(3, 'step');
    expect(screen.getByTestId('yarl').dataset.index).toBe('1');
  });

  it('closes and reports it when no slide is left', () => {
    const onChange = vi.fn();
    const { rerender } = render(mount(photos, onChange));
    fireEvent.click(screen.getByTestId('photo-card-3'));

    rerender(mount([], onChange, 3));
    expect(onChange).toHaveBeenLastCalledWith(null, 'close');
    expect(screen.queryByTestId('yarl')).toBeNull();
  });

  it('does nothing when another photo leaves', () => {
    const onChange = vi.fn();
    const { rerender } = render(mount(photos, onChange));
    fireEvent.click(screen.getByTestId('photo-card-3'));
    onChange.mockClear();

    rerender(mount(photos.filter((p) => p.id !== 1), onChange, 3));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByTestId('yarl').dataset.index).toBe('1');
  });
});
