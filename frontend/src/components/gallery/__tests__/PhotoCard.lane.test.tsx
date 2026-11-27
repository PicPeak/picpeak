/**
 * The single lane of a Gallery Folio tile (issue 2617). Badges in corners
 * collide on a narrow or panoramic tile: a 50 px high one holds one 32 px row
 * and no more. In lane mode every mark and every control of the card sits in
 * one row along the bottom: the marks from the left, dropped whole when the
 * row is full, the actions and the checkbox at the right end. No element of
 * the card is placed anywhere else, so none can land on another.
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { PhotoCard } from '../PhotoCard';
import { GalleryTileBadgesProvider } from '../GalleryTileBadges';
import { PhotoSalesProvider } from '../../../features/photo-sales/PhotoSalesContext';
import type { Photo } from '../../../types';

vi.mock('../../common', () => ({
  AuthenticatedImage: ({ src, alt }: { src: string; alt?: string }) => <img src={src} alt={alt} />,
}));
vi.mock('../../../contexts/GuestIdentityContext', () => ({ useGuestIdentityOptional: () => null }));
vi.mock('../../../hooks/useInputMode', () => ({ useInputMode: () => 'mouse' }));

const photo = {
  id: 7, filename: 'IMG_0001.jpg', url: '/p/7', thumbnail_url: '/t/7', type: 'individual', size: 1,
  uploaded_at: '2026-01-01T00:00:00Z', first_look: true, sale_token: 'tok',
  my_color_label: 'red',
} as unknown as Photo;

const sales = {
  providers: [], snipcartPublicKey: null, enabled: true, checkoutReady: true, slug: 'demo', price: 5, currency: 'EUR',
  itemDescription: '', freeCount: 0, accessDays: 30, promoCode: null,
} as never;

function renderCard(props: Partial<React.ComponentProps<typeof PhotoCard>> = {}) {
  const onClick = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient()}>
      <PhotoSalesProvider value={sales}>
        <GalleryTileBadgesProvider value={{ firstLookLabel: 'First look', folderNameOf: () => 'Saturday' }}>
          <PhotoCard
            photo={photo}
            isSelected={false}
            isSelectionMode={false}
            onClick={onClick}
            onDownload={() => {}}
            onToggleSelect={() => {}}
            className="tile group"
            imageProps={{ src: '/t/7', alt: 'IMG_0001.jpg' }}
            overlayBaseClassName="shade"
            feedbackEnabled
            feedbackOptions={{ allowLikes: true }}
            slug="demo"
            topLeftControl={<button type="button">Hide from guests</button>}
            lane
            laneMarks={<span data-testid="video-mark">Video</span>}
            {...props}
          />
        </GalleryTileBadgesProvider>
      </PhotoSalesProvider>
    </QueryClientProvider>,
  );
  return { onClick };
}

const lane = () => document.querySelector('[data-photo-card-lane]') as HTMLElement;
const marks = () => lane().querySelector('[data-lane-marks]') as HTMLElement;
const controls = () => lane().querySelector('[data-lane-controls]') as HTMLElement;

describe('PhotoCard lane mode', () => {
  it('puts every mark into the lane, from the left', () => {
    renderCard();
    const inMarks = within(marks());
    expect(inMarks.getByRole('button', { name: 'Hide from guests' })).toBeInTheDocument();
    expect(inMarks.getByRole('button', { name: /Add photo to cart/ })).toBeInTheDocument();
    expect(inMarks.getByTestId('first-look-badge')).toBeInTheDocument();
    expect(inMarks.getByTestId('folder-hint')).toBeInTheDocument();
    expect(inMarks.getByTestId('video-mark')).toBeInTheDocument();
    // In the row's flow, not placed on a corner of their own.
    for (const mark of Array.from(marks().children)) {
      expect(mark.className).not.toMatch(/\b(top|bottom|left|right)-\d/);
    }
  });

  it('drops a mark that does not fit whole, never cutting one', () => {
    renderCard();
    // One row high; what wraps to a second row is clipped out entirely.
    expect(marks()).toHaveClass('flex-wrap', 'h-8', 'overflow-hidden', 'min-w-0');
  });

  it('puts the actions and the checkbox at the right end, and nothing at the corners', () => {
    renderCard();
    const inControls = within(controls());
    expect(inControls.getByRole('button', { name: 'Like photo' })).toBeInTheDocument();
    expect(inControls.getByRole('checkbox')).toBeInTheDocument();
    expect(controls()).toHaveClass('shrink-0');
    // Nothing of the card is placed at a corner outside the lane.
    const placed = Array.from(document.querySelectorAll('.tile *'))
      .filter((el) => /\b(top|bottom|left|right)-\d/.test(el.getAttribute('class') || ''))
      .filter((el) => el !== lane() && !lane().contains(el));
    expect(placed).toEqual([]);
  });

  it('opens the photo from the tile itself, by click or by keyboard, with no separate view button', () => {
    const { onClick } = renderCard();
    expect(screen.queryByRole('button', { name: 'View full size' })).toBeNull();
    // A native button the size of the tile: Tab reaches it, Enter and Space press it.
    const open = screen.getByRole('button', { name: 'IMG_0001.jpg' });
    expect(open.tagName).toBe('BUTTON');
    expect(open).toHaveClass('absolute', 'inset-0');
    fireEvent.click(open);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('shows the actions only while the tile is revealed, so at rest the marks have the row', () => {
    renderCard();
    expect(controls().querySelector('[data-lane-actions]')).toHaveClass('hidden');
  });

  it('leaves the other layouts\' card as it was', () => {
    renderCard({ lane: false, laneMarks: undefined });
    expect(document.querySelector('[data-photo-card-lane]')).toBeNull();
    expect(screen.getByRole('button', { name: 'View full size' })).toBeInTheDocument();
  });
});
