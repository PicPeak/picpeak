/**
 * Timeline lazy-mounts and releases its tiles (issue 1733).
 *
 * Timeline passed `loading: 'lazy'` on the <img> and nothing to PhotoCard,
 * but AuthenticatedImage fetches in an effect the moment it mounts, so every
 * tile of the gallery was requested on first render and kept for the life of
 * the page. It now opts into PhotoCard's two bands: tiles outside the load
 * band render the skeleton, tiles inside it mount, and tiles that leave the
 * wider keep band unmount again. The `aspect-square` box holds either way.
 */
import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

import { TimelineGalleryLayout } from '../TimelineGalleryLayout';
import type { Photo } from '../../../../types';
import { lazyBands } from '../lazyBands';

// The bands the layout hands PhotoCard are px derived from the viewport
// height (lazyBands.ts), so key the mock by what the component really passes.
const { load: LOAD_BAND, keep: KEEP_BAND } = lazyBands(window.innerHeight);

/**
 * Which bands the tiles are currently inside; the test drives these directly
 * and re-renders, as PhotoCard.releaseBand.test.tsx does. Live, not latched:
 * the latch belongs to the non-releasing path, which Timeline no longer uses.
 */
let bands: Record<string, boolean> = {};
vi.mock('react-intersection-observer', () => ({
  useInView: ({ rootMargin, skip }: { rootMargin?: string; skip?: boolean }) => ({
    ref: () => {},
    inView: skip ? false : Boolean(bands[rootMargin ?? '']),
  }),
}));

const lifecycle = { mounted: 0, unmounted: 0 };
vi.mock('../../../common', () => ({
  AuthenticatedImage: ({ src, alt }: { src: string; alt?: string }) => {
    React.useEffect(() => {
      lifecycle.mounted += 1;
      return () => { lifecycle.unmounted += 1; };
    }, []);
    return <img data-testid="tile" src={src} alt={alt} />;
  },
  PoweredBy: () => null,
}));

vi.mock('../../../../contexts/ThemeContext', () => ({
  useTheme: () => ({ theme: { gallerySettings: { timelineGrouping: 'day' } } }),
}));
vi.mock('../../../../contexts/GuestIdentityContext', () => ({
  useGuestIdentityOptional: () => null,
}));
vi.mock('../../../../hooks/useLocalizedDate', () => ({
  useLocalizedDate: () => ({ formatTime: (v: string) => v }),
}));

const photos: Photo[] = Array.from({ length: 4 }, (_, i) => ({
  id: i + 1,
  filename: `IMG_${i}.jpg`,
  url: `/api/gallery/x/photo/${i + 1}`,
  thumbnail_url: `/api/gallery/x/thumbnail/${i + 1}`,
  type: 'individual',
  size: 1,
  uploaded_at: `2026-01-01T1${i}:00:00Z`,
  width: 4000,
  height: 3000,
} as Photo));

const props = {
  photos,
  slug: 'x',
  onPhotoClick: () => {},
  onDownload: () => {},
  selectedPhotos: new Set<number>(),
  isSelectionMode: false,
  allowDownloads: true,
} as never;

const scrollTo = (rerender: (ui: React.ReactElement) => void, next: Record<string, boolean>) => {
  bands = next;
  rerender(<TimelineGalleryLayout {...props} />);
};

beforeEach(() => {
  bands = {};
  lifecycle.mounted = 0;
  lifecycle.unmounted = 0;
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => 275 });
  Object.defineProperty(window, 'devicePixelRatio', { value: 1, configurable: true });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('TimelineGalleryLayout — lazy mount and release', () => {
  it('renders skeletons, not images, for tiles outside the load band', () => {
    const { container } = render(<TimelineGalleryLayout {...props} />);
    expect(screen.queryAllByTestId('tile')).toHaveLength(0);
    expect(lifecycle.mounted).toBe(0);
    // The skeleton fills the tile; the aspect-square container is still there.
    expect(container.querySelectorAll('.photo-card.aspect-square')).toHaveLength(photos.length);
    expect(container.querySelectorAll('.skeleton')).toHaveLength(photos.length);
  });

  it('mounts tiles that enter the load band and releases them past the keep band', () => {
    const { rerender, container } = render(<TimelineGalleryLayout {...props} />);

    scrollTo(rerender, { [LOAD_BAND]: true, [KEEP_BAND]: true });
    expect(screen.getAllByTestId('tile')).toHaveLength(photos.length);
    expect(lifecycle.mounted).toBe(photos.length);

    // Just outside the load band but still inside the keep band: nothing
    // changes. This gap is the hysteresis that stops edge-scrolling thrash.
    scrollTo(rerender, { [LOAD_BAND]: false, [KEEP_BAND]: true });
    expect(screen.getAllByTestId('tile')).toHaveLength(photos.length);
    expect(lifecycle.unmounted).toBe(0);

    // Beyond the keep band: released, and the box stays.
    scrollTo(rerender, { [LOAD_BAND]: false, [KEEP_BAND]: false });
    expect(screen.queryAllByTestId('tile')).toHaveLength(0);
    expect(lifecycle.unmounted).toBe(photos.length);
    expect(container.querySelectorAll('.photo-card.aspect-square')).toHaveLength(photos.length);
  });
});
