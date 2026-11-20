/**
 * Highlights (issue 2549): a photo flagged `is_highlight` gets the larger tile
 * where the layout can draw one, and nothing changes without the flag.
 */
import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

import { MasonryGalleryLayout } from '../MasonryGalleryLayout';
import { mosaicTileStyle } from '../MosaicGalleryLayout';
import { layoutQuilted, quiltedSpan } from '../quiltedWindow';
import { premiumTileSize } from '../premiumGeometry';
import { storyFeatured } from '../story/StoryFixedGrid';
import type { Photo } from '../../../../types';

vi.mock('../../../common', () => ({
  AuthenticatedImage: ({ src, alt }: { src: string; alt?: string }) => <img data-testid="tile" src={src} alt={alt} />,
  PoweredBy: () => null,
}));
vi.mock('react-intersection-observer', () => ({
  useInView: () => ({ ref: () => {}, inView: true }),
}));
vi.mock('../../../../contexts/ThemeContext', () => ({
  useTheme: () => ({ theme: { gallerySettings: { masonryMode: 'quilted' } } }),
}));
vi.mock('../../../../contexts/GuestIdentityContext', () => ({
  useGuestIdentityOptional: () => null,
}));

const photo = (id: number, width: number, height: number, is_highlight?: boolean) => ({
  id, width, height, ...(is_highlight === undefined ? {} : { is_highlight }),
});

describe('quiltedSpan with highlights', () => {
  it('a highlight spans two columns and two rows, whatever its shape', () => {
    expect(quiltedSpan(photo(1, 4000, 3000, true))).toEqual({ columns: 2, rows: 2 });
    expect(quiltedSpan(photo(1, 1000, 3000, true))).toEqual({ columns: 2, rows: 2 });
    expect(quiltedSpan(photo(1, 3000, 1000, true))).toEqual({ columns: 2, rows: 2 });
  });

  it('without the flag, or with it false, the shape decides as before', () => {
    for (const flag of [undefined, false]) {
      expect(quiltedSpan(photo(1, 4000, 3000, flag))).toEqual({ columns: 1, rows: 1 });
      expect(quiltedSpan(photo(1, 3001, 2000, flag))).toEqual({ columns: 2, rows: 1 });
      expect(quiltedSpan(photo(1, 699, 1000, flag))).toEqual({ columns: 1, rows: 2 });
    }
  });

  it('lays a highlight out 2x2 and keeps every photo in list order', () => {
    const photos = [photo(1, 4000, 3000), photo(2, 4000, 3000, true), photo(3, 4000, 3000), photo(4, 4000, 3000)];
    const layout = layoutQuilted(photos, 3, 200, 16)!;
    expect(layout.placements.get(2)).toEqual({ gridColumn: '2 / span 2', gridRow: '1 / span 2' });
    expect(layout.placements.get(3)).toEqual({ gridColumn: '1 / span 1', gridRow: '2 / span 1' });
    expect(layout.rowCount).toBe(3);
    expect(layout.items.map((item) => item.listIndex)).toEqual([0, 1, 2, 3]);
  });

  it('spans only the rows in a one-column grid, so the layout (and the window) holds', () => {
    expect(quiltedSpan(photo(1, 4000, 3000, true), 1)).toEqual({ columns: 1, rows: 2 });
    expect(quiltedSpan(photo(1, 4000, 3000, true), 3)).toEqual({ columns: 2, rows: 2 });
    const layout = layoutQuilted([photo(1, 4000, 3000), photo(2, 4000, 3000, true), photo(3, 4000, 3000)], 1, 200, 16)!;
    expect(layout).not.toBeNull();
    expect(layout.placements.get(2)).toEqual({ gridColumn: '1 / span 1', gridRow: '2 / span 2' });
    expect(layout.rowCount).toBe(4);
  });

  it('places Story\'s grid sparse, as its stylesheet does: no backfilling ahead of list order', () => {
    // Three columns: 1 and 2 on row 1, the 2x2 highlight 3 does not fit beside
    // them and goes to row 2. Dense would backfill 4 into row 1, sparse not.
    const photos = [photo(1, 4000, 3000), photo(2, 4000, 3000), photo(3, 4000, 3000, true), photo(4, 4000, 3000)];
    const story = (p: { is_highlight?: boolean }) => (p.is_highlight ? { columns: 2, rows: 2 } : { columns: 1, rows: 1 });
    expect(layoutQuilted(photos, 3, 400, 16, story)!.placements.get(4))
      .toEqual({ gridColumn: '3 / span 1', gridRow: '1 / span 1' });
    expect(layoutQuilted(photos, 3, 400, 16, story, 'sparse')!.placements.get(4))
      .toEqual({ gridColumn: '3 / span 1', gridRow: '2 / span 1' });
  });
});

describe('Masonry quilted tiles', () => {
  const photos = (flags: (boolean | undefined)[]): Photo[] => flags.map((flag, i) => ({
    id: i + 1, filename: `IMG_${i}.jpg`, url: `/p/${i + 1}`, thumbnail_url: `/t/${i + 1}`, type: 'individual',
    size: 1, uploaded_at: '2026-01-01T00:00:00Z', width: 4000, height: 3000,
    ...(flag === undefined ? {} : { is_highlight: flag }),
  } as Photo));
  const props = (list: Photo[]) => ({
    photos: list, slug: 'x', onPhotoClick: () => {}, onDownload: () => {},
    selectedPhotos: new Set<number>(), isSelectionMode: false, allowDownloads: true,
  }) as never;
  const tileClasses = () => screen.getAllByTestId('tile')
    .map((img) => img.closest('.photo-card')!.className.split(/\s+/).filter((c) => c.endsWith('span-2')).join(' '));

  beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => 1440 });
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders as before without highlights', () => {
    render(<MasonryGalleryLayout {...props(photos([undefined, false, undefined]))} />);
    expect(tileClasses()).toEqual(['', '', '']);
  });

  it('gives a highlight both spans', () => {
    render(<MasonryGalleryLayout {...props(photos([undefined, true, false]))} />);
    expect(tileClasses()).toEqual(['', 'col-span-2 row-span-2', '']);
  });

  it('gives a highlight only the rows in a one-column grid', () => {
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => 300 });
    render(<MasonryGalleryLayout {...props(photos([undefined, true, false]))} />);
    expect(tileClasses()).toEqual(['', 'row-span-2', '']);
  });
});

describe('Mosaic tiles', () => {
  const tile = (width: number, height: number, is_highlight?: boolean) => mosaicTileStyle({ id: 1, width, height, is_highlight } as Photo);

  it('keep the photo\'s shape without highlights', () => {
    expect(tile(4000, 3000)).toEqual({ breakInside: 'avoid', aspectRatio: String(4000 / 3000) });
    expect(tile(2000, 3000, false)).toEqual({ breakInside: 'avoid', aspectRatio: String(2000 / 3000) });
  });

  it('make a highlight half as tall again in its own column, never narrower than 1:2', () => {
    expect(tile(3000, 2000, true)).toEqual({ breakInside: 'avoid', aspectRatio: '1' });
    expect(tile(2000, 3000, true)).toEqual({ breakInside: 'avoid', aspectRatio: '0.5' });
    expect(tile(3000, 1000, true).aspectRatio).toBe('2');
    expect(tile(3000, 1000, true)).not.toHaveProperty('columnSpan');
  });
});

describe('Premium tiles', () => {
  it('keep the photo\'s shape without highlights, 1200x800 when unknown', () => {
    expect(premiumTileSize({ width: 4000, height: 3000 })).toEqual({ width: 4000, height: 3000 });
    expect(premiumTileSize({ width: 4000, height: 3000, is_highlight: false })).toEqual({ width: 4000, height: 3000 });
    expect(premiumTileSize({})).toEqual({ width: 1200, height: 800 });
  });

  it('make a highlight half as tall again, never narrower than 1:2', () => {
    expect(premiumTileSize({ width: 3000, height: 2000, is_highlight: true })).toEqual({ width: 3000, height: 3000 });
    expect(premiumTileSize({ width: 2000, height: 3000, is_highlight: true })).toEqual({ width: 2000, height: 4000 });
  });

  it('never makes a photo taller than 1:2 shorter by highlighting it', () => {
    expect(premiumTileSize({ width: 1000, height: 3000, is_highlight: true })).toEqual({ width: 1000, height: 3000 });
    expect(premiumTileSize({ width: 1200, height: 2000, is_highlight: true })).toEqual({ width: 1200, height: 2400 });
    expect(mosaicTileStyle({ id: 1, width: 1000, height: 3000, is_highlight: true } as Photo).aspectRatio)
      .toBe(String(1000 / 3000));
  });
});

describe('Story grid', () => {
  it('features the first card of a larger grid, and every highlight', () => {
    expect(storyFeatured({}, 0, true)).toBe(true);
    expect(storyFeatured({}, 0, false)).toBe(false);
    expect(storyFeatured({}, 3, true)).toBe(false);
    expect(storyFeatured({ is_highlight: false }, 3, true)).toBe(false);
    expect(storyFeatured({ is_highlight: true }, 3, false)).toBe(true);
  });
});
