/**
 * The tile a click opens the lightbox from reaches the lightbox, for the
 * opening photo to grow out of. Opened any other way (a `?photo=` link) there
 * is none, and a tile whose image has not loaded yet has nothing to offer.
 * The tile is the photo tile around the click (`data-grid-tile`), and its
 * image the tile's first, whatever else the tile or the page holds.
 */
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import type { Photo } from '../../../types';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, fallback?: unknown) => (typeof fallback === 'string' ? fallback : key) }),
}));
vi.mock('react-toastify', () => ({ toast: { info: vi.fn(), error: vi.fn() } }));
vi.mock('../../../contexts/ThemeContext', () => ({ useTheme: () => ({ theme: { galleryLayout: 'grid' } }) }));
vi.mock('../../../contexts/DownloadQuotaContext', () => ({
  useDownloadQuota: () => ({ allows: () => true, canDownload: () => true, remaining: null }),
}));
vi.mock('../../../hooks/useGallery', () => ({ useDownloadPhoto: () => ({ mutate: vi.fn() }) }));
vi.mock('../../../services/gallery.service', () => ({ galleryService: {} }));
vi.mock('../../../services/analytics.service', () => ({ analyticsService: { trackDownload: vi.fn() } }));
vi.mock('../../common', () => ({ Button: ({ children, ...rest }: React.ComponentProps<'button'>) => <button {...rest}>{children}</button> }));
vi.mock('../DownloadQuotaNotice', () => ({ DownloadQuotaNotice: () => null }));
vi.mock('../DownloadResolutionModal', () => ({ DownloadResolutionModal: () => null }));
vi.mock('../HeroHeader', () => ({ HeroHeader: () => null }));
// A tile as the layouts render it (PhotoCard): the photo inside a clickable
// card marked as a tile, with an overlay and a badge image after it. Next to
// the grid, a picture that belongs to no tile.
vi.mock('../layouts', () => ({
  GridGalleryLayout: ({ photos, onPhotoClick }: { photos: Photo[]; onPhotoClick: (i: number) => void }) => (
    <div>
      <img data-testid="banner" src="blob:banner" alt="" />
      <button data-testid="outside" onClick={() => onPhotoClick(0)} />
      {photos.map((photo, index) => (
        <div key={photo.id} data-grid-tile="" data-testid={`tile-${photo.id}`} onClick={() => onPhotoClick(index)}>
          <img src={`blob:tile-${photo.id}`} alt="" />
          <span data-testid={`overlay-${photo.id}`} />
          <img src="blob:badge" alt="" />
        </div>
      ))}
    </div>
  ),
}));
const lightboxProps = vi.hoisted(() => ({ openOrigin: undefined as unknown }));
vi.mock('../PhotoLightbox', () => ({
  PhotoLightbox: ({ openOrigin }: { openOrigin?: unknown }) => {
    lightboxProps.openOrigin = openOrigin;
    return <div data-testid="lightbox" />;
  },
}));

import { PhotoGridWithLayouts } from '../PhotoGridWithLayouts';

const photos = [10, 11].map((id) => ({ id, filename: `${id}.jpg` } as Photo));

const loaded = (img: HTMLImageElement, rect = { left: 40, top: 120, width: 180, height: 180 }) => {
  Object.defineProperty(img, 'complete', { value: true });
  Object.defineProperty(img, 'naturalWidth', { value: 300 });
  img.getBoundingClientRect = () => ({ ...rect, right: rect.left + rect.width, bottom: rect.top + rect.height, x: rect.left, y: rect.top, toJSON() {} });
};
const tileImage = (id: number) => screen.getByTestId(`tile-${id}`).querySelector('img') as HTMLImageElement;

afterEach(() => { lightboxProps.openOrigin = undefined; });

describe('PhotoGridWithLayouts — the tile the lightbox opens from', () => {
  it('hands the clicked tile image and its place to the lightbox', () => {
    render(<PhotoGridWithLayouts photos={photos} slug="g" />);
    loaded(tileImage(11));

    // On the overlay, as a real click on a card usually is.
    fireEvent.click(screen.getByTestId('overlay-11'), { detail: 1, clientX: 100, clientY: 200 });

    expect(screen.getByTestId('lightbox')).toBeTruthy();
    expect(lightboxProps.openOrigin).toEqual({
      src: 'blob:tile-11',
      rect: { left: 40, top: 120, width: 180, height: 180 },
    });
  });

  it('takes a keyboard click, which has no position, from the tile itself', () => {
    render(<PhotoGridWithLayouts photos={photos} slug="g" />);
    loaded(tileImage(10));
    fireEvent.click(screen.getByTestId('tile-10'), { detail: 0 });
    expect(lightboxProps.openOrigin).toMatchObject({ src: 'blob:tile-10' });
  });

  it('finds nothing outside a tile, even with a single picture on the way up', () => {
    render(<PhotoGridWithLayouts photos={photos} slug="g" />);
    loaded(screen.getByTestId('banner') as HTMLImageElement);
    fireEvent.click(screen.getByTestId('outside'), { detail: 0 });
    expect(screen.getByTestId('lightbox')).toBeTruthy();
    expect(lightboxProps.openOrigin).toBeNull();
  });

  it('has nothing to grow from while the tile image is still loading', () => {
    render(<PhotoGridWithLayouts photos={photos} slug="g" />);
    fireEvent.click(screen.getByTestId('overlay-11'), { detail: 1, clientX: 100, clientY: 200 });
    expect(screen.getByTestId('lightbox')).toBeTruthy();
    expect(lightboxProps.openOrigin).toBeNull();
  });

  it('opens a `?photo=` link without one', () => {
    render(<PhotoGridWithLayouts photos={photos} slug="g" openPhotoId={11} />);
    expect(screen.getByTestId('lightbox')).toBeTruthy();
    expect(lightboxProps.openOrigin).toBeNull();
  });
});
