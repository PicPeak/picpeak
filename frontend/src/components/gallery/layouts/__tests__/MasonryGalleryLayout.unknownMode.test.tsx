/**
 * A Masonry mode the layout has no pass for must still show the photos
 * (issue 2444): it used to fall through to the columns render with no columns
 * filled, an empty gallery with no error.
 */
import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

import { MasonryGalleryLayout } from '../MasonryGalleryLayout';
import type { Photo } from '../../../../types';

// Record the src every card is mounted with, so a remount at a different
// width is visible as a second, different url for the same photo.
const mounted: string[] = [];
vi.mock('../../../common', () => ({
  AuthenticatedImage: ({ src, alt }: { src: string; alt?: string }) => {
    mounted.push(src);
    return <img data-testid="tile" src={src} alt={alt} />;
  },
  PoweredBy: () => null,
}));

// Columns mode is lazy since issue 1733; jsdom has no IntersectionObserver,
// so every tile is reported in view and the mount count is what it was.
vi.mock('react-intersection-observer', () => ({
  useInView: () => ({ ref: () => {}, inView: true }),
}));

let masonryMode: unknown = 'columns';
vi.mock('../../../../contexts/ThemeContext', () => ({
  useTheme: () => ({ theme: { gallerySettings: { masonryMode } } }),
}));

vi.mock('../../../../contexts/GuestIdentityContext', () => ({
  useGuestIdentityOptional: () => null,
}));

const photos: Photo[] = Array.from({ length: 6 }, (_, i) => ({
  id: i + 1,
  filename: `IMG_${i}.jpg`,
  url: `/api/gallery/x/photo/${i + 1}`,
  thumbnail_url: `/api/gallery/x/thumbnail/${i + 1}`,
  type: 'individual',
  size: 1,
  uploaded_at: '2026-01-01T00:00:00Z',
  width: 4000,
  height: 3000,
} as Photo));

/**
 * jsdom reports 0 for every offsetWidth, so both the grid container and the
 * individual tiles have to be stood up. They need different values — the
 * container is what picks the column count, the tile is what picks the tier —
 * so the stub keys off the container's own class.
 */
function stubWidths({ container, tile }: { container: number; tile: number }) {
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get(this: HTMLElement) {
      return String(this.className).includes('photo-grid') ? container : tile;
    },
  });
}

const props = {
  photos,
  slug: 'x',
  onPhotoClick: () => {},
  onDownload: () => {},
  selectedPhotos: new Set<number>(),
  isSelectionMode: false,
  allowDownloads: true,
} as never;

beforeEach(() => {
  mounted.length = 0;
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

describe('MasonryGalleryLayout — every stored mode shows the photos (issue 2444)', () => {
  it.each(['justified', 'grid'])('renders all photos for masonryMode %s', (value) => {
    masonryMode = value;
    stubWidths({ container: 1440, tile: 275 });
    render(<MasonryGalleryLayout {...props} />);
    expect(screen.getAllByTestId('tile')).toHaveLength(photos.length);
  });
});
