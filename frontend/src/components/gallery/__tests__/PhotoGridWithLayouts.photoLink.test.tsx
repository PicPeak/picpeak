/**
 * Link to a single photo (issue 1733) — the host side of the contract.
 * PhotoGridWithLayouts opens its lightbox on the photo the URL asks for
 * (`openPhotoId`), closes it on null, ignores an id that is not in its list,
 * and reports the lightbox's own moves (`open` / `step` / `close`) so the
 * container can mirror them to `?photo=`.
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import type { Photo } from '../../../types';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, fallback?: unknown) => (typeof fallback === 'string' ? fallback : key) }),
}));
vi.mock('react-toastify', () => ({ toast: { info: vi.fn(), error: vi.fn() } }));
// vi.mock is hoisted above every import; vi.hoisted keeps the switch with it.
const layoutSwitch = vi.hoisted(() => ({ galleryLayout: 'grid' }));
vi.mock('../../../contexts/ThemeContext', () => ({ useTheme: () => ({ theme: { galleryLayout: layoutSwitch.galleryLayout } }) }));
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
vi.mock('../layouts', () => ({
  GridGalleryLayout: ({ photos, onPhotoClick }: { photos: Photo[]; onPhotoClick: (i: number) => void }) => (
    <div>
      {photos.map((photo, index) => (
        <button key={photo.id} data-testid={`tile-${photo.id}`} onClick={() => onPhotoClick(index)} />
      ))}
    </div>
  ),
  // A full-page layout owns its lightbox and reports through the callback.
  GalleryPremiumLayout: ({ photos, onLightboxPhotoChange }: {
    photos: Photo[]; onLightboxPhotoChange?: (id: number | null, reason: string) => void;
  }) => (
    <div data-testid="premium">
      {photos.map((photo) => (
        <button key={photo.id} data-testid={`ptile-${photo.id}`} onClick={() => onLightboxPhotoChange?.(photo.id, 'open')} />
      ))}
    </div>
  ),
}));
vi.mock('../PhotoLightbox', () => ({
  PhotoLightbox: ({ photos, initialIndex, onClose, onCurrentPhotoChange }: {
    photos: Photo[]; initialIndex: number; onClose: () => void; onCurrentPhotoChange?: (id: number) => void;
  }) => {
    const [index, setIndex] = React.useState(initialIndex);
    // As the real lightbox does: an index past the end is clamped in an
    // effect (so one render later), and only a photo that exists is reported.
    React.useEffect(() => {
      if (photos.length > 0 && index > photos.length - 1) setIndex(photos.length - 1);
    }, [photos.length, index]);
    const currentId = photos[index]?.id;
    React.useEffect(() => { if (currentId !== undefined) onCurrentPhotoChange?.(currentId); }, [currentId, onCurrentPhotoChange]);
    const current = photos[index] ?? photos[photos.length - 1];
    return (
      <div data-testid="lightbox" data-photo={current?.id}>
        <button data-testid="next" onClick={() => setIndex((i) => i + 1)} />
        <button data-testid="close" onClick={onClose} />
      </div>
    );
  },
}));

import { PhotoGridWithLayouts } from '../PhotoGridWithLayouts';

const photos = [10, 11, 12].map((id) => ({ id, filename: `${id}.jpg` } as Photo));

describe('PhotoGridWithLayouts — link to a single photo (issue 1733)', () => {
  it('reports open, step and close from the lightbox', () => {
    const onChange = vi.fn();
    render(<PhotoGridWithLayouts photos={photos} slug="g" openPhotoId={null} onLightboxPhotoChange={onChange} />);
    expect(screen.queryByTestId('lightbox')).toBeNull();

    fireEvent.click(screen.getByTestId('tile-11'));
    expect(onChange).toHaveBeenCalledWith(11, 'open');
    expect(screen.getByTestId('lightbox').dataset.photo).toBe('11');

    fireEvent.click(screen.getByTestId('next'));
    expect(onChange).toHaveBeenLastCalledWith(12, 'step');

    fireEvent.click(screen.getByTestId('close'));
    expect(onChange).toHaveBeenLastCalledWith(null, 'close');
    expect(screen.queryByTestId('lightbox')).toBeNull();
  });

  it('opens on the photo the URL asks for and closes on null', () => {
    const { rerender } = render(<PhotoGridWithLayouts photos={photos} slug="g" openPhotoId={12} />);
    expect(screen.getByTestId('lightbox').dataset.photo).toBe('12');

    rerender(<PhotoGridWithLayouts photos={photos} slug="g" openPhotoId={null} />);
    expect(screen.queryByTestId('lightbox')).toBeNull();
  });

  it('follows the lightbox to a neighbour when the open photo leaves a non-empty list', () => {
    // The lightbox clamps onto a neighbour and reports the step, so the URL
    // stays on a photo that is actually shown.
    const onChange = vi.fn();
    const { rerender } = render(
      <PhotoGridWithLayouts photos={photos} slug="g" openPhotoId={11} onLightboxPhotoChange={onChange} />,
    );
    expect(screen.getByTestId('lightbox').dataset.photo).toBe('11');

    rerender(
      <PhotoGridWithLayouts photos={photos.filter((p) => p.id !== 11)} slug="g" openPhotoId={11} onLightboxPhotoChange={onChange} />,
    );
    expect(onChange).toHaveBeenLastCalledWith(12, 'step');
    expect(onChange).not.toHaveBeenCalledWith(null, 'close');
    expect(screen.getByTestId('lightbox').dataset.photo).toBe('12');
  });

  it('stays open on the previous photo when the last one is removed and others remain', () => {
    // The lightbox's clamp lands a render after the list changed; the host
    // must not close in between.
    const onChange = vi.fn();
    const { rerender } = render(
      <PhotoGridWithLayouts photos={photos} slug="g" openPhotoId={12} onLightboxPhotoChange={onChange} />,
    );
    expect(screen.getByTestId('lightbox').dataset.photo).toBe('12');

    rerender(
      <PhotoGridWithLayouts photos={photos.filter((p) => p.id !== 12)} slug="g" openPhotoId={12} onLightboxPhotoChange={onChange} />,
    );
    expect(onChange).not.toHaveBeenCalledWith(null, 'close');
    expect(onChange).toHaveBeenLastCalledWith(11, 'step');
    expect(screen.getByTestId('lightbox').dataset.photo).toBe('11');
  });

  it('closes, reporting it, when the filtered list empties under the open photo', () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <PhotoGridWithLayouts photos={photos} slug="g" openPhotoId={12} onLightboxPhotoChange={onChange} />,
    );
    expect(screen.getByTestId('lightbox').dataset.photo).toBe('12');

    rerender(<PhotoGridWithLayouts photos={[]} slug="g" openPhotoId={12} onLightboxPhotoChange={onChange} />);
    expect(onChange).toHaveBeenLastCalledWith(null, 'close');
    expect(screen.queryByTestId('lightbox')).toBeNull();
  });

  it('keeps the lightbox when another photo leaves the list', () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <PhotoGridWithLayouts photos={photos} slug="g" openPhotoId={12} onLightboxPhotoChange={onChange} />,
    );
    rerender(
      <PhotoGridWithLayouts photos={photos.filter((p) => p.id !== 10)} slug="g" openPhotoId={12} onLightboxPhotoChange={onChange} />,
    );
    expect(onChange).not.toHaveBeenCalledWith(null, 'close');
    expect(screen.getByTestId('lightbox')).toBeTruthy();
  });

  it('closes a layout-owned lightbox when the list empties, and leaves it alone otherwise', () => {
    layoutSwitch.galleryLayout = 'gallery-premium';
    try {
      const onChange = vi.fn();
      const { rerender } = render(
        <PhotoGridWithLayouts photos={photos} slug="g" openPhotoId={null} onLightboxPhotoChange={onChange} />,
      );
      fireEvent.click(screen.getByTestId('ptile-11'));
      expect(onChange).toHaveBeenLastCalledWith(11, 'open');

      // The layout keeps its own index on a non-empty list: no close from here.
      rerender(
        <PhotoGridWithLayouts photos={photos.filter((p) => p.id !== 11)} slug="g" openPhotoId={11} onLightboxPhotoChange={onChange} />,
      );
      expect(onChange).not.toHaveBeenCalledWith(null, 'close');

      // Empty list: the layout and its lightbox unmount, so the close is reported.
      rerender(<PhotoGridWithLayouts photos={[]} slug="g" openPhotoId={11} onLightboxPhotoChange={onChange} />);
      expect(onChange).toHaveBeenLastCalledWith(null, 'close');
      expect(screen.queryByTestId('premium')).toBeNull();
    } finally {
      layoutSwitch.galleryLayout = 'grid';
    }
  });

  it('opens nothing for an id that is not in the list it shows', () => {
    render(<PhotoGridWithLayouts photos={photos} slug="g" openPhotoId={999} />);
    expect(screen.queryByTestId('lightbox')).toBeNull();
  });

  it('resolves once the list it shows contains the photo', () => {
    const { rerender } = render(<PhotoGridWithLayouts photos={photos.slice(0, 1)} slug="g" openPhotoId={12} />);
    expect(screen.queryByTestId('lightbox')).toBeNull();
    rerender(<PhotoGridWithLayouts photos={photos} slug="g" openPhotoId={12} />);
    expect(screen.getByTestId('lightbox').dataset.photo).toBe('12');
  });
});
