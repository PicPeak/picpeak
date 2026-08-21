/**
 * Masonry columns mode must not mount cards into an unmeasured layout (#1095).
 *
 * The column count starts at 3 and the greedy distribution runs off a
 * hardcoded 300px estimate until the container has been measured. Cards
 * mounted into that guess are torn down when it settles — photos move to a
 * different parent column — and since each mount picks its tier from its own
 * width, the two mounts request two DIFFERENT urls. On a 1440px desktop that
 * was 45 of 62 photos downloading twice.
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

vi.mock('../../../../contexts/ThemeContext', () => ({
  useTheme: () => ({ theme: { gallerySettings: { masonryMode: 'columns' } } }),
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

describe('MasonryGalleryLayout — columns mode mounts cards once', () => {
  it('shows placeholders instead of cards until the container is measured', () => {
    stubWidths({ container: 0, tile: 0 }); // never measured
    render(<MasonryGalleryLayout {...props} />);
    expect(screen.queryAllByTestId('tile')).toHaveLength(0);
    expect(mounted).toHaveLength(0);
  });

  it('requests exactly one url per photo once measured', () => {
    stubWidths({ container: 1440, tile: 275 });
    render(<MasonryGalleryLayout {...props} />);

    // Six photos, six mounts — not twelve. A card mounted into the unmeasured
    // 3-column guess and remounted at the settled width would show up here as
    // a second entry for the same photo.
    expect(mounted).toHaveLength(photos.length);
    expect(new Set(mounted).size).toBe(photos.length);
  });

  it('sizes tiles from the settled column count, not the initial 3', () => {
    // 1440 measured -> 5 columns -> ~275 CSS px tiles at DPR 1, which the
    // canonical thumbnail covers. The unmeasured 3-column guess would be
    // ~470px and would have pulled the 600 tier for every photo.
    stubWidths({ container: 1440, tile: 275 });
    render(<MasonryGalleryLayout {...props} />);
    expect(mounted.some((s) => s.includes('?w='))).toBe(false);
  });
});
