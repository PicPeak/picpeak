/**
 * Releasing offscreen grid tiles (#1287).
 *
 * The pre-load band made tiles arrive in time; it did nothing about them never
 * leaving. A tile that has been scrolled past keeps its object URL, and where
 * image protection is on a full-resolution canvas the browser may not evict,
 * for the life of the page — so a several-hundred-photo grid grows monotonically
 * until the browser discards the tab.
 *
 * Unmounting is what frees those, so that is what these assert: the tile's
 * subtree really goes away when it is far enough out, really comes back, and
 * never flickers on ordinary scrolling. The `releaseRootMargin`-less path is
 * pinned too, because every other layout still depends on the old latch.
 */
import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

import { PhotoCard } from '../PhotoCard';
import type { Photo } from '../../../types';

const LOAD_BAND = '100% 0px';
const KEEP_BAND = '300% 0px';

/** Which bands the tile is currently inside; the test drives these directly. */
let bands: Record<string, boolean> = {};
// `triggerOnce` has to be modelled, not ignored: it is the whole difference
// between a layout that opts in to releasing and one that does not, so a mock
// that always reports live visibility would quietly turn the latch test into a
// test of the mock.
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

// Counting mounts and unmounts is the whole point: it is the unmount that
// revokes the object URL and drops the canvas.
const lifecycle = { mounted: 0, unmounted: 0 };
vi.mock('../../common', () => ({
  AuthenticatedImage: ({ src }: { src: string }) => {
    React.useEffect(() => {
      lifecycle.mounted += 1;
      return () => { lifecycle.unmounted += 1; };
    }, []);
    return <img data-testid="tile" src={src} alt="" />;
  },
}));
vi.mock('../../../contexts/GuestIdentityContext', () => ({
  useGuestIdentityOptional: () => null,
}));

const PHOTO = {
  id: 7,
  filename: 'IMG_0001.jpg',
  url: '/api/gallery/x/photo/7',
  thumbnail_url: '/api/gallery/x/thumbnail/7',
  type: 'individual',
  size: 1,
  uploaded_at: '2026-01-01T00:00:00Z',
} as Photo;

function renderCard(props: Partial<React.ComponentProps<typeof PhotoCard>> = {}) {
  return render(
    <PhotoCard
      photo={PHOTO}
      isSelected={false}
      isSelectionMode={false}
      onClick={() => {}}
      onDownload={() => {}}
      onToggleSelect={() => {}}
      className="tile aspect-square"
      skeletonClassName="skeleton aspect-square"
      overlayBaseClassName="overlay"
      imageProps={{ src: PHOTO.thumbnail_url!, alt: PHOTO.filename }}
      lazy
      inViewRootMargin={LOAD_BAND}
      releaseRootMargin={KEEP_BAND}
      {...props}
    />,
  );
}

const scrollTo = (
  rerender: (ui: React.ReactElement) => void,
  next: Record<string, boolean>,
  props: Partial<React.ComponentProps<typeof PhotoCard>> = {},
) => {
  bands = next;
  rerender(
    <PhotoCard
      photo={PHOTO}
      isSelected={false}
      isSelectionMode={false}
      onClick={() => {}}
      onDownload={() => {}}
      onToggleSelect={() => {}}
      className="tile aspect-square"
      skeletonClassName="skeleton aspect-square"
      overlayBaseClassName="overlay"
      imageProps={{ src: PHOTO.thumbnail_url!, alt: PHOTO.filename }}
      lazy
      inViewRootMargin={LOAD_BAND}
      releaseRootMargin={KEEP_BAND}
      {...props}
    />,
  );
};

beforeEach(() => {
  bands = {};
  lifecycle.mounted = 0;
  lifecycle.unmounted = 0;
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get() { return 200; },
  });
});

describe('grid tiles release when they are far enough out of view', () => {
  it('does not load a tile that is only inside the outer band', () => {
    bands = { [KEEP_BAND]: true };
    renderCard();
    expect(screen.queryByTestId('tile')).toBeNull();
    expect(lifecycle.mounted).toBe(0);
  });

  it('loads inside the pre-load band and releases past the outer band', () => {
    bands = { [LOAD_BAND]: true, [KEEP_BAND]: true };
    const { rerender } = renderCard();
    expect(screen.getByTestId('tile')).toBeTruthy();
    expect(lifecycle.mounted).toBe(1);

    // Scrolled well past: outside both bands.
    scrollTo(rerender, {});
    expect(screen.queryByTestId('tile')).toBeNull();
    // The unmount is the release — object URL revoked, canvas dropped.
    expect(lifecycle.unmounted).toBe(1);
  });

  it('holds the tile in the gap between the bands, so scrolling cannot thrash', () => {
    bands = { [LOAD_BAND]: true, [KEEP_BAND]: true };
    const { rerender } = renderCard();

    // Past the load band but still within the keep band — the hysteresis gap.
    scrollTo(rerender, { [KEEP_BAND]: true });
    expect(screen.getByTestId('tile')).toBeTruthy();
    expect(lifecycle.unmounted).toBe(0);

    // Back towards the viewport without ever having been released.
    scrollTo(rerender, { [LOAD_BAND]: true, [KEEP_BAND]: true });
    expect(lifecycle.mounted).toBe(1);
  });

  it('brings a released tile back when it returns', () => {
    bands = { [LOAD_BAND]: true, [KEEP_BAND]: true };
    const { rerender } = renderCard();
    scrollTo(rerender, {});
    expect(screen.queryByTestId('tile')).toBeNull();

    scrollTo(rerender, { [LOAD_BAND]: true, [KEEP_BAND]: true });
    expect(screen.getByTestId('tile')).toBeTruthy();
    expect(lifecycle.mounted).toBe(2);
  });

  it('keeps the old latch for layouts that do not opt in', () => {
    bands = { [LOAD_BAND]: true };
    const { rerender } = renderCard({ releaseRootMargin: undefined });
    expect(screen.getByTestId('tile')).toBeTruthy();

    // Far outside everything. A measured layout has no skeleton that holds the
    // box, so releasing there would reflow — it must stay mounted.
    scrollTo(rerender, {}, { releaseRootMargin: undefined });
    expect(screen.getByTestId('tile')).toBeTruthy();
    expect(lifecycle.unmounted).toBe(0);
  });
});
