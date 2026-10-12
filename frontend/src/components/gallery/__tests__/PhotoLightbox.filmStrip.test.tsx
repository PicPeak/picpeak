/**
 * Film strip and hold-to-scrub in the lightbox (issue 1733, backlog item B5).
 *
 *  - the strip mounts a window of thumbnails around the open photo, never the
 *    whole gallery, and only ever asks for thumbnails;
 *  - a held arrow key steps at a throttled rate and, until it is let go,
 *    requests no preview, sends no view beacon and leaves `?photo=` alone;
 *  - a single press behaves as it always did.
 */
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Photo } from '../../../types';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: string | Record<string, unknown>) => {
      if (typeof options === 'string') return options;
      const template = options?.defaultValue;
      if (typeof template !== 'string') return key;
      return template.replace(/{{(\w+)}}/g, (_, name: string) => String(options?.[name]));
    },
  }),
}));
vi.mock('../../../hooks/useDevToolsProtection', () => ({ useDevToolsProtection: () => undefined }));
vi.mock('../../../hooks/useGallery', () => ({ useSavePhotoToDevice: () => ({ mutate: vi.fn(), isPending: false }) }));
vi.mock('../../../hooks/useFeedbackLimitModal', () => ({ useFeedbackLimitModal: () => ({ modal: null, handleError: () => false }) }));
vi.mock('../../../contexts/GuestIdentityContext', () => ({ useGuestIdentityOptional: () => null }));
vi.mock('../../../services/feedback.service', () => ({
  feedbackService: {
    getGalleryFeedbackSettings: vi.fn().mockResolvedValue({ feedback_enabled: false }),
    getPhotoFeedback: vi.fn().mockResolvedValue(null),
  },
}));
vi.mock('../../../services/gallery.service', () => ({ galleryService: { trackPhotoView: vi.fn() } }));
vi.mock('../../common', () => ({
  AuthenticatedImage: ({ src, alt, queuePriority }: { src: string; alt: string; queuePriority?: string }) => (
    <img alt={alt} data-src={src} data-priority={queuePriority ?? 'normal'} />
  ),
}));

import { PhotoLightbox } from '../PhotoLightbox';
import { galleryService } from '../../../services/gallery.service';
import { SCRUB_IDLE_RELEASE_MS } from '../hooks/useLightboxScrub';

vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });

const stubViewport = (desktop: boolean) => {
  vi.stubGlobal('matchMedia', () => ({ matches: desktop, addEventListener() {}, removeEventListener() {} }));
};

const makePhotos = (count: number) => Array.from({ length: count }, (_, i) => ({
  id: i + 1,
  filename: `${i + 1}.jpg`,
  url: `/original/${i + 1}`,
  preview_url: `/preview/${i + 1}`,
  thumbnail_url: `/thumb/${i + 1}`,
} as Photo));

const trackPhotoView = vi.mocked(galleryService.trackPhotoView);
const requested = () => Array.from(document.querySelectorAll('[data-src]')).map((el) => el.getAttribute('data-src') || '');
const previewsRequested = () => requested().filter((src) => src.startsWith('/preview/'));
const strip = () => screen.getByRole('list', { name: 'Photos' });
const counter = (text: string) => screen.getByText(text);

beforeEach(() => {
  stubViewport(true);
  trackPhotoView.mockClear();
});

describe('lightbox film strip', () => {
  it('mounts only the window around the open photo, thumbnails only', () => {
    render(<PhotoLightbox photos={makePhotos(500)} initialIndex={250} onClose={vi.fn()} slug="g" />);

    const buttons = within(strip()).getAllByRole('button');
    expect(buttons).toHaveLength(21);
    expect(buttons[0]).toHaveAccessibleName('Photo 241 of 500');
    expect(buttons[20]).toHaveAccessibleName('Photo 261 of 500');

    const current = buttons.filter((button) => button.getAttribute('aria-current') === 'true');
    expect(current).toHaveLength(1);
    expect(current[0]).toHaveAccessibleName('Photo 251 of 500');

    const stripSources = Array.from(strip().querySelectorAll('[data-src]')).map((el) => el.getAttribute('data-src'));
    expect(stripSources).toHaveLength(21);
    expect(stripSources.every((src) => src?.startsWith('/thumb/'))).toBe(true);
  });

  it('does not wrap the window around the ends of the list', () => {
    render(<PhotoLightbox photos={makePhotos(500)} initialIndex={0} onClose={vi.fn()} slug="g" />);
    expect(within(strip()).getAllByRole('button')).toHaveLength(11);
  });

  it('shows a placeholder for a photo without a thumbnail, never its original', () => {
    const photos = makePhotos(5);
    photos[3] = { ...photos[3], thumbnail_url: undefined };
    render(<PhotoLightbox photos={photos} initialIndex={0} onClose={vi.fn()} slug="g" />);

    const button = within(strip()).getByRole('button', { name: 'Photo 4 of 5' });
    expect(within(button).getByTestId('film-strip-placeholder')).toBeInTheDocument();
    expect(button.querySelector('[data-src]')).toBeNull();
    expect(Array.from(strip().querySelectorAll('[data-src]')).some((el) => el.getAttribute('data-src')?.startsWith('/original/'))).toBe(false);
  });

  it('names a photo by its filename when the lightbox shows filenames', () => {
    const photos = makePhotos(3);
    photos[1] = { ...photos[1], original_filename: 'IMG_0042.CR3' };
    render(<PhotoLightbox photos={photos} initialIndex={0} onClose={vi.fn()} slug="g" showOriginalFilename />);
    expect(within(strip()).getByRole('button', { name: 'Photo 2 of 3: IMG_0042.CR3' })).toBeInTheDocument();
  });

  it('jumps to the clicked photo without taking focus', () => {
    const onCurrentPhotoChange = vi.fn();
    render(<PhotoLightbox photos={makePhotos(500)} initialIndex={250} onClose={vi.fn()} slug="g" onCurrentPhotoChange={onCurrentPhotoChange} />);

    const target = within(strip()).getByRole('button', { name: 'Photo 257 of 500' });
    expect(target).toHaveAttribute('tabindex', '-1');
    // The mousedown is cancelled, which is what keeps a click from focusing it.
    expect(fireEvent.mouseDown(target)).toBe(false);
    fireEvent.click(target);

    expect(counter('257 / 500')).toBeInTheDocument();
    expect(within(strip()).getByRole('button', { name: 'Photo 257 of 500' })).toHaveAttribute('aria-current', 'true');
    expect(trackPhotoView).toHaveBeenLastCalledWith('g', 257);
    expect(onCurrentPhotoChange).toHaveBeenLastCalledWith(257);
    // The arrow keys still belong to the lightbox.
    fireEvent.keyDown(document, { key: 'ArrowRight' });
    expect(counter('258 / 500')).toBeInTheDocument();
  });

  it('is not mounted on a small or touch screen', () => {
    stubViewport(false);
    render(<PhotoLightbox photos={makePhotos(50)} initialIndex={5} onClose={vi.fn()} slug="g" />);
    expect(screen.queryByTestId('lightbox-film-strip')).toBeNull();
    expect(requested().some((src) => src.startsWith('/thumb/'))).toBe(false);
  });
});

describe('lightbox hold-to-scrub', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** `count` OS key repeats, 30 ms apart: about a second of holding for 30. */
  const holdKey = (key: string, count: number) => {
    for (let i = 0; i < count; i += 1) {
      fireEvent.keyDown(document, { key, repeat: true });
      act(() => { vi.advanceTimersByTime(30); });
    }
  };

  const open = (onCurrentPhotoChange = vi.fn()) => {
    render(<PhotoLightbox photos={makePhotos(500)} initialIndex={100} onClose={vi.fn()} slug="g" onCurrentPhotoChange={onCurrentPhotoChange} />);
    return onCurrentPhotoChange;
  };

  it('leaves a single press as it was: one step, its preview and its beacon at once', () => {
    const onCurrentPhotoChange = open();
    expect(trackPhotoView.mock.calls).toEqual([['g', 101]]);

    fireEvent.keyDown(document, { key: 'ArrowRight' });
    fireEvent.keyUp(document, { key: 'ArrowRight' });

    expect(counter('102 / 500')).toBeInTheDocument();
    expect(trackPhotoView.mock.calls).toEqual([['g', 101], ['g', 102]]);
    expect(onCurrentPhotoChange.mock.calls).toEqual([[101], [102]]);
    expect(screen.queryByTestId('lightbox-scrub-stand-in')).toBeNull();
    expect(document.querySelector('[data-src^="/preview/102"]')).toHaveAttribute('data-priority', 'high');
  });

  it('throttles the repeats and holds preview, beacon and URL until the key is let go', () => {
    const onCurrentPhotoChange = open();
    fireEvent.keyDown(document, { key: 'ArrowRight' });
    expect(trackPhotoView).toHaveBeenCalledTimes(2);

    // 30 repeats over 900 ms: one step per 110 ms or more, not one per repeat.
    holdKey('ArrowRight', 30);

    expect(counter('110 / 500')).toBeInTheDocument();
    // Nothing for the eight photos passed over.
    expect(trackPhotoView).toHaveBeenCalledTimes(2);
    expect(onCurrentPhotoChange).toHaveBeenCalledTimes(2);
    expect(previewsRequested()).toEqual([]);
    // The thumbnail stands in, and the strip has moved with it.
    const standIn = screen.getByTestId('lightbox-scrub-stand-in');
    expect(standIn.querySelector('[data-src]')).toHaveAttribute('data-src', '/thumb/110');
    expect(within(strip()).getByRole('button', { name: 'Photo 110 of 500' })).toHaveAttribute('aria-current', 'true');

    fireEvent.keyUp(document, { key: 'ArrowRight' });

    // Exactly one beacon and one URL update, for the photo landed on.
    expect(trackPhotoView).toHaveBeenCalledTimes(3);
    expect(trackPhotoView).toHaveBeenLastCalledWith('g', 110);
    expect(onCurrentPhotoChange.mock.calls).toEqual([[101], [102], [110]]);
    // Its preview is fetched as the slide on screen, its neighbours behind it.
    expect(document.querySelector('[data-src^="/preview/110"]')).toHaveAttribute('data-priority', 'high');
    expect(document.querySelector('[data-src^="/preview/109"]')).toHaveAttribute('data-priority', 'prefetch');
    expect(document.querySelector('[data-src^="/preview/111"]')).toHaveAttribute('data-priority', 'prefetch');

    // Nothing more once the scrub is over.
    act(() => { vi.advanceTimersByTime(5000); });
    expect(trackPhotoView).toHaveBeenCalledTimes(3);
    expect(onCurrentPhotoChange).toHaveBeenCalledTimes(3);
  });

  it('scrubs backwards too', () => {
    open();
    holdKey('ArrowLeft', 10);
    fireEvent.keyUp(document, { key: 'ArrowLeft' });
    expect(counter('98 / 500')).toBeInTheDocument();
    expect(trackPhotoView.mock.calls).toEqual([['g', 101], ['g', 98]]);
  });

  it('ends the scrub when the repeats stop without a keyup', () => {
    open();
    holdKey('ArrowRight', 10);
    expect(trackPhotoView).toHaveBeenCalledTimes(1);

    act(() => { vi.advanceTimersByTime(SCRUB_IDLE_RELEASE_MS); });

    expect(trackPhotoView).toHaveBeenCalledTimes(2);
    expect(trackPhotoView).toHaveBeenLastCalledWith('g', 104);
    expect(previewsRequested().some((src) => src.startsWith('/preview/104'))).toBe(true);
  });

  it('does not count a photo twice when a scrub ends where it began', () => {
    render(<PhotoLightbox photos={makePhotos(1)} initialIndex={0} onClose={vi.fn()} slug="g" />);
    holdKey('ArrowRight', 5);
    fireEvent.keyUp(document, { key: 'ArrowRight' });
    expect(trackPhotoView.mock.calls).toEqual([['g', 1]]);
  });
});
