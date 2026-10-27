/**
 * The opening photo is on screen at once, Pixieset-style:
 *
 *  - opened from a tile, the tile's own image grows from the tile to the
 *    photo's place, framed at the photo's aspect, and stays until the preview
 *    has loaded, instead of a black stage for as long as the preview takes;
 *  - with reduced motion it is there without the animation;
 *  - opened any other way, and for videos, the lightbox is as it was.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Photo } from '../../../types';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string, d?: unknown) => (typeof d === 'string' ? d : k) }) }));
vi.mock('../../../hooks/useDevToolsProtection', () => ({ useDevToolsProtection: () => undefined }));
vi.mock('../../../hooks/useGallery', () => ({ useSavePhotoToDevice: () => ({ mutate: vi.fn(), isPending: false }) }));
vi.mock('../../../hooks/useFeedbackLimitModal', () => ({ useFeedbackLimitModal: () => ({ modal: null, handleError: () => false }) }));
vi.mock('../../../contexts/GuestIdentityContext', () => ({ useGuestIdentityOptional: () => null }));
vi.mock('../../../services/feedback.service', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../services/feedback.service')>(),
  feedbackService: {
    getGalleryFeedbackSettings: vi.fn().mockResolvedValue({ feedback_enabled: false }),
    getPhotoFeedback: vi.fn().mockResolvedValue(null),
  },
}));
vi.mock('../../../services/gallery.service', () => ({ galleryService: { trackPhotoView: vi.fn() } }));
vi.mock('../../common', () => ({
  AuthenticatedImage: ({ src, alt, queuePriority, onLoad, onError }: {
    src: string; alt: string; queuePriority?: string; onLoad?: () => void; onError?: () => void;
  }) => (
    <img
      alt={alt}
      data-src={src}
      data-priority={queuePriority ?? 'normal'}
      onLoad={() => onLoad?.()}
      onError={() => onError?.()}
    />
  ),
}));
vi.mock('../VideoPlayer', () => ({ VideoPlayer: () => <div data-testid="video-player" /> }));

import { PhotoLightbox } from '../PhotoLightbox';

vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });

const photos = [1, 2, 3].map((id) => ({
  id,
  filename: `${id}.jpg`,
  url: `/original/${id}`,
  preview_url: `/preview/${id}`,
  thumbnail_url: `/thumb/${id}`,
  width: 3000,
  height: 2000,
} as Photo));

// A square tile at (100, 300); the stage is 1000 x 800.
const origin = { src: 'blob:tile-2', rect: { left: 100, top: 300, width: 200, height: 200 } };

let reducedMotion = false;
const animate = vi.fn();

beforeEach(() => {
  reducedMotion = false;
  animate.mockClear();
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('reduced-motion') ? reducedMotion : false,
    addEventListener() {},
    removeEventListener() {},
  }));
  HTMLElement.prototype.animate = animate;
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1000);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(800);
  // The lightbox's toolbar, which the stage stops above.
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(64);
});

afterEach(() => {
  vi.restoreAllMocks();
  delete (HTMLElement.prototype as Partial<HTMLElement>).animate;
});

const standIn = () => screen.queryByTestId('lightbox-scrub-stand-in');
const grow = () => screen.queryByTestId('lightbox-open-grow') as HTMLImageElement | null;
const preview = () => document.querySelector('[data-src^="/preview/2"][data-priority="high"]') as HTMLElement;

describe('PhotoLightbox opening', () => {
  it('opens as it did without a tile to grow from (a `?photo=` link)', () => {
    render(<PhotoLightbox photos={photos} initialIndex={1} onClose={vi.fn()} slug="g" />);
    expect(grow()).toBeNull();
    expect(standIn()).toBeNull();
  });

  it('lets the tile image go when the preview does not decode', () => {
    render(<PhotoLightbox photos={photos} initialIndex={1} onClose={vi.fn()} slug="g" openOrigin={origin} />);
    fireEvent.error(preview());
    expect(grow()).toBeNull();
    expect(standIn()).toBeNull();
  });

  it('grows the tile image from the tile to the photo, until the preview has loaded', () => {
    render(<PhotoLightbox photos={photos} initialIndex={1} onClose={vi.fn()} slug="g" openOrigin={origin} />);

    // The tile's own decoded image, in place for the first paint: nothing
    // to fetch.
    expect(grow()?.getAttribute('src')).toBe('blob:tile-2');
    expect(standIn()).toBeNull();
    // 3:2 photo in a 1000 x 800 stage: 1000 x 666.67, centred.
    expect(grow()!.style.width).toBe('1000px');
    expect(parseFloat(grow()!.style.height)).toBeCloseTo(666.67, 1);
    expect(parseFloat(grow()!.style.top)).toBeCloseTo(66.67, 1);

    expect(animate).toHaveBeenCalledTimes(1);
    const [frames, options] = animate.mock.calls[0];
    expect(options).toMatchObject({ duration: 250 });
    // Starts covering the tile: scale 0.3 makes the photo 300 x 200, centred
    // on the tile, and the clip trims it to the tile's 200 x 200.
    const [, x, y, scale] = (frames[0].transform as string).match(/translate\((.+)px, (.+)px\) scale\((.+)\)/)!.map(Number);
    expect(x).toBeCloseTo(50, 3);
    expect(y).toBeCloseTo(233.33, 1);
    expect(scale).toBeCloseTo(0.3, 5);
    const inset = (frames[0].clipPath as string).match(/[\d.]+/g)!.map(Number);
    expect(inset.map((px) => Math.round(px * 100) / 100)).toEqual([0, 166.67, 0, 166.67]);
    expect(frames[1]).toMatchObject({ transform: 'none' });

    fireEvent.load(preview());
    expect(grow()).toBeNull();
  });

  it('with reduced motion, puts the tile image in place without the animation', () => {
    reducedMotion = true;
    render(<PhotoLightbox photos={photos} initialIndex={1} onClose={vi.fn()} slug="g" openOrigin={origin} />);
    expect(grow()!.style.width).toBe('1000px');
    expect(grow()!.style.visibility).toBe('');
    expect(animate).not.toHaveBeenCalled();
  });

  it('falls back to the fetched thumbnail when the tile image is gone', () => {
    render(<PhotoLightbox photos={photos} initialIndex={1} onClose={vi.fn()} slug="g" openOrigin={origin} />);
    fireEvent.error(grow()!);
    expect(grow()).toBeNull();
    const shown = standIn()!.querySelector('[data-priority="high"]');
    expect(shown?.getAttribute('data-src')).toBe('/thumb/2');
    fireEvent.load(preview());
    expect(standIn()).toBeNull();
  });

  it('is for the opening photo only', () => {
    render(<PhotoLightbox photos={photos} initialIndex={1} onClose={vi.fn()} slug="g" openOrigin={origin} />);
    fireEvent.keyDown(document, { key: 'ArrowRight' });
    expect(grow()).toBeNull();
    expect(standIn()).toBeNull();
    fireEvent.keyDown(document, { key: 'ArrowLeft' });
    expect(grow()).toBeNull();
    expect(standIn()).toBeNull();
  });

  it('leaves videos as they were', () => {
    const withVideo = photos.map((photo) => (photo.id === 2 ? { ...photo, media_type: 'video' } as Photo : photo));
    render(<PhotoLightbox photos={withVideo} initialIndex={1} onClose={vi.fn()} slug="g" openOrigin={origin} />);
    expect(grow()).toBeNull();
    expect(standIn()).toBeNull();
  });
});
