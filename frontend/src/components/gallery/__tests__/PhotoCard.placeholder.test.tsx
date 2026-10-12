/**
 * Blurred placeholder behind a loading tile (issue 1733, B1).
 *
 * The photo list carries a ThumbHash per photo; the tile paints it until the
 * real thumbnail has loaded. Pinned here:
 *  - it is there while the image loads and fades once it has
 *  - it takes no space (absolute over the tile) and is invisible to
 *    assistive tech and to the pointer
 *  - reduced motion drops the fade
 *  - a photo without a hash renders exactly as before
 *  - nothing is decoded for a tile that is not mounted, and a released tile
 *    gets its placeholder back when it returns (the lazy mount and release
 *    band this must not regress)
 */
import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import { PhotoCard } from '../PhotoCard';
import * as thumbHash from '../../../utils/thumbHash';
import type { Photo } from '../../../types';

const LOAD_BAND = '100% 0px';
const KEEP_BAND = '300% 0px';
const HASH = 'HwgKPZpgh3dwh3eHdXh2eKCACPeH';

let bands: Record<string, boolean> = {};
vi.mock('react-intersection-observer', () => ({
  useInView: (
    { rootMargin, skip, triggerOnce }:
    { rootMargin?: string; skip?: boolean; triggerOnce?: boolean },
  ) => {
    const latched = React.useRef(false);
    const live = skip ? false : Boolean(bands[rootMargin ?? '']);
    if (live) latched.current = true;
    return { ref: () => {}, inView: triggerOnce ? latched.current : live };
  },
}));

// Stands in for the fetch: the image "loads" when the test fires `load`.
vi.mock('../../common', () => ({
  AuthenticatedImage: ({ src, onLoad }: { src: string; onLoad?: (d: { width: number; height: number }) => void }) => (
    <img data-testid="tile" src={src} alt="" onLoad={() => onLoad?.({ width: 300, height: 300 })} />
  ),
}));
vi.mock('../../../contexts/GuestIdentityContext', () => ({
  useGuestIdentityOptional: () => null,
}));

const PHOTO = {
  id: 7,
  filename: 'IMG_0001.jpg',
  url: '/api/gallery/x/photo/7',
  thumbnail_url: '/api/gallery/x/thumbnail/7',
  thumb_hash: HASH,
  type: 'individual',
  size: 1,
  uploaded_at: '2026-01-01T00:00:00Z',
} as Photo;

const card = (props: Partial<React.ComponentProps<typeof PhotoCard>> = {}) => (
  <PhotoCard
    photo={PHOTO}
    isSelected={false}
    isSelectionMode={false}
    onClick={() => {}}
    onDownload={() => {}}
    onToggleSelect={() => {}}
    className="tile relative aspect-square"
    skeletonClassName="skeleton aspect-square"
    overlayBaseClassName="overlay"
    imageProps={{ src: PHOTO.thumbnail_url!, alt: PHOTO.filename, className: 'w-full h-full object-cover rounded-lg' }}
    {...props}
  />
);

describe('PhotoCard placeholder', () => {
  beforeEach(() => {
    bands = {};
    vi.restoreAllMocks();
  });

  it('shows the placeholder until the thumbnail has loaded, then fades it', () => {
    render(card());
    const placeholder = screen.getByTestId('tile-placeholder');
    const image = placeholder.firstElementChild as HTMLElement;
    expect(image.style.backgroundImage).toContain('data:image/png;base64,');
    expect(placeholder.className).toContain('opacity-100');

    fireEvent.load(screen.getByTestId('tile'));

    expect(placeholder.className).toContain('opacity-0');
    expect(placeholder.className).not.toContain('opacity-100');
    expect(placeholder.className).toContain('transition-opacity');
  });

  it('takes no space, no pointer and no place in the accessibility tree', () => {
    render(card());
    const placeholder = screen.getByTestId('tile-placeholder');
    // Over the tile's box, so the image arriving moves nothing.
    expect(placeholder.className).toContain('absolute');
    expect(placeholder.className).toContain('inset-0');
    expect(placeholder.className).toContain('pointer-events-none');
    expect(placeholder.getAttribute('aria-hidden')).toBe('true');
    // The image's own rounding, since not every tile clips.
    expect(placeholder.className).toContain('rounded-lg');
    // The blur is drawn past the box and clipped, so its soft rim never shows.
    expect(placeholder.className).toContain('overflow-hidden');
    expect((placeholder.firstElementChild as HTMLElement).className).toContain('-inset-[4%]');
    // After the image, before the badges and the overlay.
    expect(screen.getByTestId('tile').nextElementSibling).toBe(placeholder);
  });

  it('drops the fade under reduced motion', () => {
    render(card());
    expect(screen.getByTestId('tile-placeholder').className).toContain('motion-reduce:transition-none');
  });

  it('renders nothing extra for a photo without a hash', () => {
    const decode = vi.spyOn(thumbHash, 'thumbHashToDataUrl');
    render(card({ photo: { ...PHOTO, thumb_hash: null } }));
    expect(screen.getByTestId('tile')).toBeTruthy();
    expect(screen.queryByTestId('tile-placeholder')).toBeNull();
    expect(decode.mock.results.every((result) => result.value === null)).toBe(true);
  });

  it('ignores a hash that does not decode', () => {
    render(card({ photo: { ...PHOTO, thumb_hash: '%%%' } }));
    expect(screen.queryByTestId('tile-placeholder')).toBeNull();
  });

  it('decodes nothing until a lazy tile mounts', () => {
    const decode = vi.spyOn(thumbHash, 'thumbHashToDataUrl');
    const lazy = { lazy: true, inViewRootMargin: LOAD_BAND, releaseRootMargin: KEEP_BAND };
    const { rerender } = render(card(lazy));
    expect(screen.queryByTestId('tile-placeholder')).toBeNull();
    expect(decode).not.toHaveBeenCalled();

    bands = { [LOAD_BAND]: true, [KEEP_BAND]: true };
    rerender(card(lazy));
    expect(screen.getByTestId('tile-placeholder')).toBeTruthy();
    expect(decode).toHaveBeenCalledWith(HASH);
  });

  it('a released tile comes back with its placeholder', () => {
    const lazy = { lazy: true, inViewRootMargin: LOAD_BAND, releaseRootMargin: KEEP_BAND };
    bands = { [LOAD_BAND]: true, [KEEP_BAND]: true };
    const { rerender } = render(card(lazy));
    fireEvent.load(screen.getByTestId('tile'));
    expect(screen.getByTestId('tile-placeholder').className).toContain('opacity-0');

    // Far away: the subtree, placeholder included, is gone.
    bands = {};
    rerender(card(lazy));
    expect(screen.queryByTestId('tile')).toBeNull();
    expect(screen.queryByTestId('tile-placeholder')).toBeNull();

    // Back: the image is fetched again, so the placeholder covers it again.
    bands = { [LOAD_BAND]: true, [KEEP_BAND]: true };
    rerender(card(lazy));
    expect(screen.getByTestId('tile-placeholder').className).toContain('opacity-100');
  });
});
