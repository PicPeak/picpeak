/**
 * The single lane of a Gallery Folio tile (issue 2617). Badges in corners
 * collide on a narrow or panoramic tile: a 50 px high one holds one 32 px row
 * and no more. In lane mode every mark and every control of the card sits in
 * one row along the bottom. From the left: the client's toggle, then the
 * decorative marks, which drop whole when the row is full; from the right:
 * the checkbox and the cart, never dropped, and before them the colour dot,
 * like and download, which drop whole in the reverse of that order. No
 * element of the card is placed anywhere else, so none can land on another.
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
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
// Interpolated, as the tile's names are ("View {{name}}").
vi.mock('react-i18next', async () => ({
  ...await vi.importActual('react-i18next'),
  useTranslation: () => ({
    t: (_key: string, fallback: string, values?: Record<string, unknown>) =>
      fallback.replace(/{{(\w+)}}/g, (_, name: string) => String(values?.[name] ?? name)),
  }),
}));

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
const actions = () => lane().querySelector('[data-lane-actions]') as HTMLElement;
const start = () => lane().querySelector('[data-lane-controls="start"]') as HTMLElement;
const end = () => lane().querySelector('[data-lane-controls="end"]') as HTMLElement;
const laneButtons = () => Array.from(lane().querySelectorAll('button'));

describe('PhotoCard lane mode', () => {
  it('puts the decorative marks into the lane, in the row\'s flow', () => {
    renderCard();
    const inMarks = within(marks());
    expect(inMarks.getByTestId('first-look-badge')).toBeInTheDocument();
    expect(inMarks.getByTestId('folder-hint')).toBeInTheDocument();
    expect(inMarks.getByTestId('video-mark')).toBeInTheDocument();
    // Not placed on a corner of their own.
    for (const mark of Array.from(marks().children)) {
      expect(mark.className).not.toMatch(/\b(top|bottom|left|right)-\d/);
    }
  });

  it('drops a mark that does not fit whole: none shrinks or is cut', () => {
    renderCard();
    // One row high; what wraps to a second row is clipped out entirely.
    expect(marks()).toHaveClass('flex-wrap', 'h-8', 'overflow-hidden', 'min-w-0');
    // A mark that could shrink would squeeze to "First ..." instead of wrapping.
    for (const id of ['first-look-badge', 'folder-hint']) {
      const mark = within(marks()).getByTestId(id);
      expect(mark).toHaveClass('shrink-0');
      expect(mark.className).not.toMatch(/max-w-\[(calc|\d+%)/);
    }
  });

  it('shows first look as its icon alone on a narrow tile, the label still in its name', () => {
    renderCard();
    // The lane is the container the mark asks about its width.
    expect(lane().className).toContain('[container-type:inline-size]');
    const badge = within(marks()).getByTestId('first-look-badge');
    expect(badge).toHaveAttribute('title', 'First look');
    expect(within(badge).getByText('First look').className).toContain('[@container_(max-width:13rem)]:sr-only');
  });

  it('keeps every control out of the parts of the lane that drop what does not fit', () => {
    renderCard();
    // Only decorative marks may drop out of the row.
    expect(marks().querySelectorAll('button, a, input, [tabindex]')).toHaveLength(0);
    // The client's toggle, the cart and the checkbox are never dropped.
    expect(within(start()).getByRole('button', { name: 'Hide from guests' })).toBeInTheDocument();
    expect(within(end()).getByRole('button', { name: /Add photo to cart for/ })).toBeInTheDocument();
    expect(within(end()).getByRole('checkbox')).toBeInTheDocument();
    for (const group of [start(), end()]) {
      expect(group).toHaveClass('shrink-0');
      expect(group).not.toHaveClass('overflow-hidden');
    }
  });

  it('sets the client\'s toggle apart from buying and selecting: the two ends of the lane', () => {
    renderCard();
    const order = Array.from(lane().children);
    expect(order.indexOf(start())).toBe(0);
    expect(order.indexOf(end())).toBe(order.length - 1);
    expect(order.indexOf(marks())).toBeGreaterThan(order.indexOf(start()));
    expect(order.indexOf(actions())).toBeLessThan(order.indexOf(end()));
  });

  it('gives every control of the lane one size and one skin', () => {
    renderCard();
    const own = laneButtons().filter((button) => button.textContent !== 'Hide from guests');
    expect(own.map((button) => button.getAttribute('aria-label') ?? button.getAttribute('role'))).toEqual([
      'Like photo', expect.stringMatching(/Add photo to cart for/), expect.stringMatching(/^Select /),
    ]);
    for (const button of own) {
      expect(button).toHaveClass('w-8', 'h-8', 'rounded-full', 'bg-white/90', 'shadow-md');
      expect(button.querySelector('svg, [data-lane-unchecked]')).not.toBeNull();
    }
    // 16 px glyphs throughout.
    for (const icon of Array.from(lane().querySelectorAll('button svg'))) {
      expect(icon).toHaveClass('w-4', 'h-4');
    }
  });

  it('shows an unchecked checkbox as an empty ring, a checked one filled with a check', () => {
    renderCard();
    const unchecked = within(end()).getByRole('checkbox');
    expect(unchecked.querySelector('[data-lane-unchecked]')).toHaveClass('rounded-full', 'border-2');
    expect(unchecked.querySelector('svg')).toBeNull();
    cleanup();
    renderCard({ isSelected: true });
    const checked = within(end()).getByRole('checkbox');
    expect(checked).toHaveClass('bg-accent-strong', 'text-accent-fg');
    expect(checked.querySelector('svg')).not.toBeNull();
  });

  it('shows the cart as one button, the price in its name', () => {
    renderCard();
    const cart = within(end()).getByRole('button', { name: /Add photo to cart for/ });
    expect(cart.textContent).toBe('');
    // The lane's skin, not the dark chip of the other layouts.
    expect(cart).not.toHaveClass('photo-sales-chip');
  });

  it('keeps the colour dot in the row while the actions show, ahead of like and download', () => {
    renderCard({ allowDownloads: true });
    // The dot is not among the marks the actions push out: it leads the
    // group that drops last, so download goes first, then like, then the dot.
    expect(within(marks()).queryByRole('img', { name: 'Marked as red' })).toBeNull();
    const items = Array.from(actions().children).filter((el) => !el.matches('[aria-hidden="true"]'));
    expect(items[0]).toContainElement(within(actions()).getByRole('img', { name: 'Marked as red' }));
    expect(items[1]).toHaveAccessibleName('Like photo');
    expect(actions()).toHaveClass('flex-wrap', 'h-8', 'overflow-hidden', 'min-w-0', 'justify-end');
    // Always laid out, so the dot shows at rest too.
    expect(actions()).not.toHaveClass('hidden');
  });

  it('offers like and download only: comments and ratings are the lightbox\'s', () => {
    cleanup();
    render(
      <QueryClientProvider client={new QueryClient()}>
        <PhotoCard
          photo={{ ...photo, sale_token: null } as unknown as Photo}
          isSelected={false}
          isSelectionMode={false}
          onClick={() => {}}
          onDownload={() => {}}
          onToggleSelect={() => {}}
          className="tile group"
          imageProps={{ src: '/t/7', alt: 'IMG_0001.jpg' }}
          overlayBaseClassName="shade"
          feedbackEnabled
          feedbackOptions={{ allowLikes: true, allowComments: true, allowRatings: true }}
          onQuickComment={() => {}}
          slug="demo"
          lane
        />
      </QueryClientProvider>,
    );
    expect(laneButtons().map((button) => button.getAttribute('aria-label'))).toEqual([
      'Like photo', 'Download photo', 'Select IMG_0001.jpg',
    ]);
    expect(screen.queryByRole('button', { name: 'Comment on photo' })).toBeNull();
  });

  it('opens the photo from the tile itself, by click or by keyboard, with no separate view button', () => {
    const { onClick } = renderCard();
    expect(screen.queryByRole('button', { name: 'View full size' })).toBeNull();
    // A native button the size of the tile: Tab reaches it, Enter and Space press it.
    const open = screen.getByRole('button', { name: 'View IMG_0001.jpg' });
    expect(open.tagName).toBe('BUTTON');
    expect(open).toHaveClass('absolute', 'inset-0');
    fireEvent.click(open);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('names a video as one on the button that opens it', () => {
    renderCard({ photo: { ...photo, media_type: 'video' } as unknown as Photo });
    expect(screen.getByRole('button', { name: 'View video IMG_0001.jpg' })).toBeInTheDocument();
  });

  it('reveals the actions on hover or keyboard focus, not on the focus a click leaves behind', () => {
    renderCard();
    const like = within(actions()).getByRole('button', { name: 'Like photo' });
    // A click or tap focuses the tile-sized button: `:focus-within` would
    // keep the actions of the last tile clicked on screen.
    expect(like).toHaveClass('hidden', 'group-hover:inline-flex', 'group-has-[:focus-visible]:inline-flex');
    expect(lane().innerHTML).not.toContain('focus-within');
  });

  it('leaves the other layouts\' card as it was', () => {
    renderCard({ lane: false, laneMarks: undefined });
    expect(document.querySelector('[data-photo-card-lane]')).toBeNull();
    expect(screen.getByRole('button', { name: 'View full size' })).toBeInTheDocument();
    expect(screen.getByTestId('first-look-badge')).toHaveClass('absolute', 'max-w-[calc(100%-1rem)]');
    expect(screen.getByRole('button', { name: /Add photo to cart for/ })).toHaveClass('photo-sales-chip');
  });
});
