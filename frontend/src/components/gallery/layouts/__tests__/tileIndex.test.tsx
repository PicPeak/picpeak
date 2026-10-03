/**
 * Clicking a tile opens that photo in the lightbox — by its position in
 * `photos`, which is what the lightbox indexes by (issue 1733).
 *
 * Masonry's columns mode and Timeline both render tiles out of order and used
 * to recover the position with a `photos.findIndex` per tile, which made every
 * render O(N²). The lookup is now a map built once per `photos` change, so
 * these pin the behaviour the map has to preserve: the index follows the
 * photo through a reorder and a filter, not the tile's render position.
 */
import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import { MasonryGalleryLayout } from '../MasonryGalleryLayout';
import { TimelineGalleryLayout } from '../TimelineGalleryLayout';
import type { Photo } from '../../../../types';

vi.mock('../../../common', () => ({
  AuthenticatedImage: ({ src, alt }: { src: string; alt?: string }) => (
    <img data-testid="tile" src={src} alt={alt} />
  ),
  PoweredBy: () => null,
}));

// jsdom has no IntersectionObserver; every tile is in view here.
vi.mock('react-intersection-observer', () => ({
  useInView: () => ({ ref: () => {}, inView: true }),
}));

vi.mock('../../../../contexts/ThemeContext', () => ({
  useTheme: () => ({ theme: { gallerySettings: { masonryMode: 'columns', timelineGrouping: 'day' } } }),
}));

vi.mock('../../../../contexts/GuestIdentityContext', () => ({
  useGuestIdentityOptional: () => null,
}));

vi.mock('../../../../hooks/useInputMode', () => ({
  useInputMode: () => 'mouse',
}));

// Timeline's time badge reads the public settings through react-query.
vi.mock('../../../../hooks/useLocalizedDate', () => ({
  useLocalizedDate: () => ({ formatTime: (v: string) => v }),
}));

// Three days, oldest first, so Timeline (newest group first) renders them in
// the opposite order to `photos`.
const photos: Photo[] = Array.from({ length: 6 }, (_, i) => ({
  id: 100 + i,
  filename: `IMG_${i}.jpg`,
  url: `/api/gallery/x/photo/${100 + i}`,
  thumbnail_url: `/api/gallery/x/thumbnail/${100 + i}`,
  type: 'individual',
  size: 1,
  uploaded_at: `2026-01-0${1 + Math.floor(i / 2)}T1${i}:00:00Z`,
  // Alternate aspect ratios so the greedy column fill does not degenerate
  // into round-robin.
  width: i % 2 ? 3000 : 4000,
  height: i % 2 ? 4000 : 3000,
} as Photo));

function stubWidths() {
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get(this: HTMLElement) {
      return String(this.className).includes('photo-grid') ? 1440 : 275;
    },
  });
}

const baseProps = {
  slug: 'x',
  onDownload: () => {},
  selectedPhotos: new Set<number>(),
  isSelectionMode: false,
  allowDownloads: true,
};

const clickTile = (filename: string) => {
  // The tile's container is the img's parent; its onClick is the tile open.
  fireEvent.click(screen.getByAltText(filename).parentElement!);
};

beforeEach(() => {
  stubWidths();
  Object.defineProperty(window, 'devicePixelRatio', { value: 1, configurable: true });
  Object.defineProperty(window, 'innerWidth', { value: 1440, configurable: true });
  vi.stubGlobal('ResizeObserver', class {
    observe() {} unobserve() {} disconnect() {}
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe.each([
  ['Masonry (columns)', MasonryGalleryLayout],
  ['Timeline', TimelineGalleryLayout],
] as const)('%s — tile index', (_name, Layout) => {
  it('opens the photo at its position in `photos`, not its render position', () => {
    const onPhotoClick = vi.fn();
    render(<Layout {...baseProps} photos={photos} onPhotoClick={onPhotoClick} />);
    expect(screen.getAllByTestId('tile')).toHaveLength(photos.length);

    clickTile('IMG_4.jpg');
    expect(onPhotoClick).toHaveBeenLastCalledWith(4);
    clickTile('IMG_0.jpg');
    expect(onPhotoClick).toHaveBeenLastCalledWith(0);
  });

  it('follows a reorder of `photos`', () => {
    const onPhotoClick = vi.fn();
    const { rerender } = render(<Layout {...baseProps} photos={photos} onPhotoClick={onPhotoClick} />);
    clickTile('IMG_5.jpg');
    expect(onPhotoClick).toHaveBeenLastCalledWith(5);

    const reversed = [...photos].reverse();
    rerender(<Layout {...baseProps} photos={reversed} onPhotoClick={onPhotoClick} />);
    clickTile('IMG_5.jpg');
    expect(onPhotoClick).toHaveBeenLastCalledWith(0);
    clickTile('IMG_2.jpg');
    expect(onPhotoClick).toHaveBeenLastCalledWith(3);
  });

  it('follows a filter of `photos`', () => {
    const onPhotoClick = vi.fn();
    const { rerender } = render(<Layout {...baseProps} photos={photos} onPhotoClick={onPhotoClick} />);

    // Drop the first two: every remaining photo moves up by two.
    const filtered = photos.slice(2);
    rerender(<Layout {...baseProps} photos={filtered} onPhotoClick={onPhotoClick} />);
    expect(screen.getAllByTestId('tile')).toHaveLength(filtered.length);
    clickTile('IMG_3.jpg');
    expect(onPhotoClick).toHaveBeenLastCalledWith(1);
  });
});
