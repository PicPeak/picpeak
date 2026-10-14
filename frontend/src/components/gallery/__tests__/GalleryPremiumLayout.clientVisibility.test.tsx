/**
 * Issue 1992: Gallery Premium renders its own card, which had no client
 * hide/show button. The card's checkbox owns top-left, so the button sits
 * right of it in the same row (below it, a short panoramic tile clipped it),
 * with the colour-label dots beside it; the click must not open the lightbox.
 */
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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
vi.mock('../../common', async () => ({
  ...await vi.importActual('../../common'),
  PoweredBy: () => null,
  AuthenticatedImage: ({ src, alt, className }: { src: string; alt?: string; className?: string }) =>
    <img src={src} alt={alt} className={className} />,
}));
vi.mock('react-photo-album', () => ({
  MasonryPhotoAlbum: ({ photos, render: renderer }: any) => <>{photos.map((photo: any, index: number) =>
    <React.Fragment key={photo.key}>{renderer.photo({}, { photo, index, width: 300, height: 200 })}</React.Fragment>
  )}</>,
}));
vi.mock('yet-another-react-lightbox', () => ({
  default: ({ open, index }: { open: boolean; index: number }) => (open ? <div data-testid="yarl" data-index={index} /> : null),
}));
vi.mock('yet-another-react-lightbox/plugins/thumbnails', () => ({ default: () => null }));
vi.mock('yet-another-react-lightbox/plugins/zoom', () => ({ default: () => null }));
vi.mock('yet-another-react-lightbox/plugins/fullscreen', () => ({ default: () => null }));
vi.mock('yet-another-react-lightbox/plugins/download', () => ({ default: () => null }));
vi.mock('yet-another-react-lightbox/plugins/captions', () => ({ default: () => null }));

import { GalleryPremiumLayout } from '../layouts/GalleryPremiumLayout';

const photos = [
  { id: 1, visibility: 'visible' },
  { id: 2, visibility: 'hidden' },
].map(({ id, visibility }) => ({
  id, visibility, my_color_label: 'red', filename: `photo-${id}.jpg`, original_filename: `original-${id}.jpg`,
  url: `/api/gallery/demo/photo/${id}`, thumbnail_url: `/api/gallery/demo/thumbnail/${id}`,
  width: 6000, height: 4000, type: 'individual', size: 1, uploaded_at: '2026-01-01T00:00:00Z',
})) as Photo[];

const mount = (extra: Record<string, unknown>) => render(
  <GalleryPremiumLayout photos={photos} slug="demo" onPhotoClick={vi.fn()} onDownload={vi.fn()}
    allowDownloads={false} {...extra} />,
);

afterEach(() => cleanup());

describe('Gallery Premium — client visibility toggle (issue 1992)', () => {
  it('renders the toggle per card beside the checkbox, with the hidden state', () => {
    mount({ isClient: true, onToggleVisibility: vi.fn() });
    const visible = screen.getByTestId('client-visibility-toggle-1');
    const hidden = screen.getByTestId('client-visibility-toggle-2');
    expect(visible).toHaveAttribute('aria-label', 'Visible to guests');
    expect(hidden).toHaveAttribute('aria-label', 'Hidden from guests');
    expect(hidden).toHaveAttribute('aria-pressed', 'true');
    // The checkbox's row, not below it: a panoramic tile can be shorter
    // than the checkbox plus the toggle.
    expect(visible.parentElement!.className).toContain('absolute top-2 left-14');

    const tileImage = (id: number) =>
      screen.getByTestId(`photo-card-${id}`).querySelector('img') as HTMLElement;
    expect(tileImage(2).className).toContain('!opacity-40');
    expect(tileImage(1).className).not.toContain('opacity-40');
    // Only the image: the eye stays at full strength.
    for (let node = hidden.parentElement; node; node = node.parentElement) {
      expect(node.className).not.toContain('opacity-40');
    }
    // The colour-label dot sits beside the eye, in the same row.
    const dot = screen.getByTestId('photo-card-2').querySelector('[aria-label^="Marked as"]') as HTMLElement;
    expect(dot.parentElement!.parentElement).toBe(hidden.parentElement);
  });

  it('keeps a hidden photo dimmed while it is selected', () => {
    // `.gallery-premium-photo-card.selected img` sets opacity: 0.9, which
    // outranks a plain `opacity-40` utility; the important variant wins.
    mount({ isClient: true, onToggleVisibility: vi.fn(), selectedPhotos: new Set([2]), isSelectionMode: true });
    const card = screen.getByTestId('photo-card-2');
    expect(card.className).toContain('selected');
    expect((card.querySelector('img') as HTMLElement).className).toContain('!opacity-40');
  });

  it('toggles without opening the lightbox', () => {
    const onToggleVisibility = vi.fn();
    mount({ isClient: true, onToggleVisibility });
    fireEvent.click(screen.getByTestId('client-visibility-toggle-2'));
    expect(onToggleVisibility).toHaveBeenCalledWith(2, 'hidden');
    expect(screen.queryByTestId('yarl')).toBeNull();
  });

  it('shows no toggle for a guest, and the dot keeps its corner', () => {
    mount({ isClient: false, onToggleVisibility: vi.fn() });
    expect(screen.queryByTestId('client-visibility-toggle-1')).toBeNull();
    const dot = screen.getByTestId('photo-card-1').querySelector('[aria-label^="Marked as"]') as HTMLElement;
    expect(dot.parentElement!.className).toContain('absolute top-2 left-2');
  });
});
