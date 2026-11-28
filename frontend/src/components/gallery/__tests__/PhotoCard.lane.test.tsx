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
const inputMode = vi.hoisted(() => ({ value: 'mouse' }));
vi.mock('../../../hooks/useInputMode', () => ({ useInputMode: () => inputMode.value }));
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

  describe('reveal', () => {
    // jsdom has no input modality: say whether a focus came from the keyboard.
    const focusVisible = (value: boolean) => vi.spyOn(Element.prototype, 'matches')
      .mockImplementation(function matches(this: Element, selector: string) {
        return selector === ':focus-visible' ? value : Element.prototype.closest.call(this, selector) === this;
      });
    const like = () => within(actions()).getByRole('button', { name: 'Like photo' });
    const open = () => screen.getByRole('button', { name: 'View IMG_0001.jpg' });

    it('shows the actions on hover, by a class alone', () => {
      renderCard();
      expect(like()).toHaveClass('hidden', 'group-hover:inline-flex');
    });

    it('shows them when the keyboard reaches the tile, and keeps them while focus moves between its controls', () => {
      const spy = focusVisible(true);
      try {
        renderCard();
        fireEvent.focus(open());
        expect(like()).toHaveClass('inline-flex');
        expect(like()).not.toHaveClass('hidden');
        // On to the next control: for an instant nothing is focused. A
        // reveal tied to `:focus-visible` or `:focus-within` in the
        // stylesheet hides the buttons right then, and the browser refuses
        // to focus the one Tab was headed for.
        fireEvent.blur(open(), { relatedTarget: like() });
        expect(like()).not.toHaveClass('hidden');
        expect(lane().innerHTML).not.toMatch(/focus-within|has-\[:focus-visible\]/);
        // Out of the tile: hidden again.
        fireEvent.blur(like(), { relatedTarget: document.body });
        expect(like()).toHaveClass('hidden');
      } finally {
        spy.mockRestore();
      }
    });

    it('stays revealed while a dialog opened from the tile has the focus, so it can come back', () => {
      const spy = focusVisible(true);
      const dialog = document.createElement('div');
      dialog.setAttribute('role', 'dialog');
      const inside = document.createElement('button');
      dialog.appendChild(inside);
      const elsewhere = document.createElement('button');
      document.body.append(dialog, elsewhere);
      try {
        renderCard();
        fireEvent.focus(open());
        // The opener hands its focus to the dialog; hidden, it could not take it back.
        fireEvent.blur(like(), { relatedTarget: inside });
        expect(like()).not.toHaveClass('hidden');
        fireEvent.focusIn(inside);
        expect(like()).not.toHaveClass('hidden');
        // Closed: focus is back on the opener, and the usual rule applies again.
        fireEvent.focusIn(like());
        expect(like()).not.toHaveClass('hidden');
        fireEvent.blur(like(), { relatedTarget: elsewhere });
        expect(like()).toHaveClass('hidden');
        // Or the dialog sends focus somewhere else: hidden then too.
        fireEvent.focus(open());
        fireEvent.blur(like(), { relatedTarget: inside });
        fireEvent.focusIn(elsewhere);
        expect(like()).toHaveClass('hidden');
      } finally {
        dialog.remove();
        elsewhere.remove();
        spy.mockRestore();
      }
    });

    it('stays hidden on the focus a click or tap leaves on the tile-sized button', () => {
      const spy = focusVisible(false);
      try {
        renderCard();
        fireEvent.focus(open());
        expect(like()).toHaveClass('hidden');
      } finally {
        spy.mockRestore();
      }
    });

    it('shows the first row again once the keyboard has left a control on a row that had dropped', () => {
      const spy = focusVisible(true);
      try {
        renderCard();
        fireEvent.focus(open());
        // Focus on a wrapped-away control scrolls its row into the lane.
        actions().scrollTop = 36;
        fireEvent.blur(like(), { relatedTarget: document.body });
        expect(actions().scrollTop).toBe(0);
      } finally {
        spy.mockRestore();
      }
    });
  });

  it('never lets the shade take a click meant for the tile\'s button', () => {
    renderCard();
    // It holds no control here, unlike the corner overlay it is in the other layouts.
    const shade = document.querySelector('.shade') as HTMLElement;
    expect(shade).toHaveClass('pointer-events-none');
    expect(shade.className).not.toContain('pointer-events-auto');
    expect(shade).toHaveClass('opacity-0', 'group-hover:opacity-100');
  });

  it('opens at once from the keyboard on a touch device, while a tap still reveals first', () => {
    inputMode.value = 'touch';
    try {
      const { onClick } = renderCard();
      const open = document.querySelector('[data-lane-open]') as HTMLElement;
      // A tap carries a click count; Enter or Space on the button does not.
      fireEvent.click(open, { detail: 1 });
      expect(onClick).not.toHaveBeenCalled();
      cleanup();

      const again = renderCard();
      fireEvent.click(document.querySelector('[data-lane-open]') as HTMLElement, { detail: 0 });
      expect(again.onClick).toHaveBeenCalledTimes(1);
    } finally {
      inputMode.value = 'mouse';
    }
  });

  it('leaves the other layouts\' card as it was', () => {
    renderCard({ lane: false, laneMarks: undefined });
    expect(document.querySelector('[data-photo-card-lane]')).toBeNull();
    expect(screen.getByRole('button', { name: 'View full size' })).toBeInTheDocument();
    expect(screen.getByTestId('first-look-badge')).toHaveClass('absolute', 'max-w-[calc(100%-1rem)]');
    expect(screen.getByRole('button', { name: /Add photo to cart for/ })).toHaveClass('photo-sales-chip');
  });
});
