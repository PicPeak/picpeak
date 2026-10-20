/**
 * Grid tile sizing (#1095).
 *
 * The tier has to be decided from the tile's real width, and it has to be
 * decided BEFORE the image is requested. Both halves are easy to break without
 * anything looking wrong: the picture still renders, just at the wrong size, or
 * at the right size after fetching the wrong one first.
 */
import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';

import { PhotoCard } from '../PhotoCard';
import { GridDensityOffered, resetGridDensityForTests, setGridDensity, useGridDensity } from '../gridDensity';
import type { Photo } from '../../../types';

// AuthenticatedImage really fetches; all this test cares about is the src it
// was handed, and how many distinct ones it saw.
const seenSrcs: string[] = [];
vi.mock('../../common', () => ({
  AuthenticatedImage: ({ src, alt }: { src: string; alt?: string }) => {
    seenSrcs.push(src);
    return <img data-testid="tile" src={src} alt={alt} />;
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
  width: 4000,
  height: 3000,
} as Photo;

/** Every tile in the document reports `width` CSS px. */
function stubTileWidth(width: number) {
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get() { return width; },
  });
}

function renderCard(props: Partial<React.ComponentProps<typeof PhotoCard>> = {}) {
  return render(
    <PhotoCard
      photo={PHOTO}
      isSelected={false}
      isSelectionMode={false}
      onClick={() => {}}
      onDownload={() => {}}
      onToggleSelect={() => {}}
      className="tile"
      overlayBaseClassName="overlay"
      imageProps={{ src: PHOTO.thumbnail_url!, alt: PHOTO.filename }}
      {...props}
    />,
  );
}

beforeEach(() => {
  seenSrcs.length = 0;
  Object.defineProperty(window, 'devicePixelRatio', { value: 3, configurable: true });
  Object.defineProperty(window, 'innerWidth', { value: 390, configurable: true });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('PhotoCard tier sizing', () => {
  it('sizes from the measured tile, not the viewport', () => {
    // A 1-up Mosaic tile on a DPR-3 phone needs 1170 device px. The viewport
    // fallback assumes 2-up and would land on 600 — visibly soft.
    stubTileWidth(390);
    renderCard();
    expect(screen.getByTestId('tile')).toHaveAttribute(
      'src', '/api/gallery/x/thumbnail/7?w=900',
    );
  });

  it('gives a dense grid the small file', () => {
    stubTileWidth(96);
    renderCard();
    // The canonical tier carries no ?w=, so these URLs stay byte-identical to
    // the ones already in browser caches.
    expect(screen.getByTestId('tile')).toHaveAttribute(
      'src', '/api/gallery/x/thumbnail/7',
    );
  });

  it('requests exactly one URL — never a fallback then a correction', () => {
    // The measurement gate exists for this. Reading the tile from a plain
    // effect would mount the image with the viewport guess, fetch it, then
    // swap the src and fetch again — every tile in the gallery, twice.
    stubTileWidth(390);
    renderCard();
    expect(new Set(seenSrcs).size).toBe(1);
    expect(seenSrcs[0]).toContain('?w=900');
  });

  it('measures non-lazy cards too', () => {
    // Mosaic, Masonry and Timeline do not pass `lazy`, so the observer entry
    // is never populated for them — they are precisely the layouts a
    // breakpoint guess gets most wrong.
    stubTileWidth(390);
    renderCard({ lazy: false });
    expect(screen.getByTestId('tile')).toHaveAttribute(
      'src', '/api/gallery/x/thumbnail/7?w=900',
    );
  });

  it('moves up a tier when the viewer enlarges the tiles, and keeps it when they shrink', () => {
    // Issue 1733, E4: the tile size changes the mounted tiles in place.
    window.localStorage.clear();
    resetGridDensityForTests();
    stubTileWidth(96);
    const card = (
      <PhotoCard
        photo={PHOTO}
        isSelected={false}
        isSelectionMode={false}
        onClick={() => {}}
        onDownload={() => {}}
        onToggleSelect={() => {}}
        className="tile"
        overlayBaseClassName="overlay"
        imageProps={{ src: PHOTO.thumbnail_url!, alt: PHOTO.filename }}
      />
    );
    render(<GridDensityOffered.Provider value>{card}</GridDensityOffered.Provider>);
    expect(screen.getByTestId('tile')).toHaveAttribute('src', '/api/gallery/x/thumbnail/7');

    stubTileWidth(390);
    act(() => setGridDensity('large'));
    expect(screen.getByTestId('tile')).toHaveAttribute('src', '/api/gallery/x/thumbnail/7?w=900');

    stubTileWidth(96);
    act(() => setGridDensity('compact'));
    expect(screen.getByTestId('tile')).toHaveAttribute('src', '/api/gallery/x/thumbnail/7?w=900');
    act(() => setGridDensity('default'));
  });

  it('takes the target width a layout animates the card to, not where the transition starts', () => {
    // Masonry rows and Flickr set the px width in `style` and transition it.
    window.localStorage.clear();
    resetGridDensityForTests();
    stubTileWidth(96);
    // Stands in for the layout: it reads the density and sizes the card from it.
    const Layout = () => {
      const width = useGridDensity() === 'large' ? 390 : 96;
      return (
        <PhotoCard
          photo={PHOTO}
          isSelected={false}
          isSelectionMode={false}
          onClick={() => {}}
          onDownload={() => {}}
          onToggleSelect={() => {}}
          className="tile"
          overlayBaseClassName="overlay"
          style={{ width, height: 100 }}
          imageProps={{ src: PHOTO.thumbnail_url!, alt: PHOTO.filename }}
        />
      );
    };
    render(<GridDensityOffered.Provider value><Layout /></GridDensityOffered.Provider>);
    expect(screen.getByTestId('tile')).toHaveAttribute('src', '/api/gallery/x/thumbnail/7');

    // The element still measures the old width at the start of its transition.
    act(() => setGridDensity('large'));
    expect(screen.getByTestId('tile')).toHaveAttribute('src', '/api/gallery/x/thumbnail/7?w=900');
    act(() => setGridDensity('default'));
  });

  it('takes the target width when a card first loads during a width transition', () => {
    // A lazy Masonry rows card that enters the load band mid-transition after
    // a tile-size change: the element still measures the old width.
    stubTileWidth(96);
    renderCard({ style: { width: 390, height: 100 } });
    expect(screen.getByTestId('tile')).toHaveAttribute('src', '/api/gallery/x/thumbnail/7?w=900');
  });

  it('leaves videos on the canonical thumbnail', () => {
    // A video's thumbnail is a poster frame, so the tier route would hand the
    // video file itself to Sharp.
    stubTileWidth(390);
    renderCard({ photo: { ...PHOTO, media_type: 'video' } as Photo });
    expect(screen.getByTestId('tile')).toHaveAttribute(
      'src', '/api/gallery/x/thumbnail/7',
    );
  });

  it('does not put ?w= on the original-photo route', () => {
    // Layouts fall back to photo.url when thumbnail_url is null, and ?w= means
    // something else there.
    stubTileWidth(390);
    renderCard({
      photo: { ...PHOTO, thumbnail_url: undefined } as Photo,
      imageProps: { src: PHOTO.url, alt: PHOTO.filename },
    });
    expect(screen.getByTestId('tile')).toHaveAttribute('src', '/api/gallery/x/photo/7');
  });
});
