/**
 * Per-tile badges on the shared card: the first-look pill (issue 1562) and
 * the "All photos" folder hint (issue 1786), both driven by the gallery
 * context rather than by each layout.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { PhotoCard } from '../PhotoCard';
import { GalleryTileBadgesProvider, type GalleryTileBadgesValue } from '../GalleryTileBadges';
import type { Photo } from '../../../types';

vi.mock('../../common', () => ({
  AuthenticatedImage: ({ src, alt }: { src: string; alt?: string }) => <img src={src} alt={alt} />,
}));
vi.mock('../../../contexts/GuestIdentityContext', () => ({
  useGuestIdentityOptional: () => null,
}));

const photo = (over: Partial<Photo> = {}) => ({
  id: 7,
  filename: 'IMG_0001.jpg',
  url: '/p/7',
  thumbnail_url: '/t/7',
  type: 'individual',
  size: 1,
  uploaded_at: '2026-01-01T00:00:00Z',
  ...over,
}) as Photo;

function renderCard(p: Photo, badges?: GalleryTileBadgesValue, isSelectionMode = false) {
  const card = (
    <PhotoCard
      photo={p}
      isSelected={false}
      isSelectionMode={isSelectionMode}
      onClick={() => {}}
      onDownload={() => {}}
      onToggleSelect={() => {}}
      imageProps={{ src: '/t/7', alt: 'IMG_0001.jpg' }}
      overlayBaseClassName="absolute inset-0"
    />
  );
  render(
    <QueryClientProvider client={new QueryClient()}>
      {badges ? <GalleryTileBadgesProvider value={badges}>{card}</GalleryTileBadgesProvider> : card}
    </QueryClientProvider>,
  );
}

describe('PhotoCard tile badges', () => {
  it('shows the event label on a first-look photo', () => {
    renderCard(photo({ first_look: true }), { firstLookLabel: 'Social media pre-delivery', folderNameOf: null });
    expect(screen.getByTestId('first-look-badge')).toHaveTextContent('Social media pre-delivery');
  });

  it('shows no badge on an ordinary photo or outside a two-stage gallery', () => {
    renderCard(photo({ first_look: false }), { firstLookLabel: 'First look', folderNameOf: null });
    expect(screen.queryByTestId('first-look-badge')).not.toBeInTheDocument();
  });

  it('marks the tile with the photo as its first image, for the lightbox to grow out of', () => {
    renderCard(photo());
    expect(document.querySelector('[data-grid-tile] img')).toHaveAttribute('src', expect.stringContaining('/t/7'));
  });

  it('shows nothing without the gallery context at all', () => {
    renderCard(photo({ first_look: true }));
    expect(screen.queryByTestId('first-look-badge')).not.toBeInTheDocument();
    expect(screen.queryByTestId('folder-hint')).not.toBeInTheDocument();
  });

  it('hints the folder in "All photos" and steps aside for the checkbox', () => {
    renderCard(photo(), { firstLookLabel: null, folderNameOf: () => 'Saturday' }, true);
    const hint = screen.getByTestId('folder-hint');
    expect(hint).toHaveTextContent('Saturday');
    expect(hint).toHaveClass('opacity-0');
  });
});
