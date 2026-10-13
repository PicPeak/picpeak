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
vi.mock('../../../services/feedback.service', async (importOriginal) => ({
  // The keybind schemes live in this module too.
  ...await importOriginal<typeof import('../../../services/feedback.service')>(),
  feedbackService: {
    getGalleryFeedbackSettings: vi.fn().mockResolvedValue({ feedback_enabled: false }),
    getPhotoFeedback: vi.fn().mockResolvedValue(null),
    submitFeedback: vi.fn().mockResolvedValue({}),
  },
}));
vi.mock('../../../services/gallery.service', () => ({ galleryService: { trackPhotoView: vi.fn() } }));
// In the order the real component would ask the shared fetch queue for a slot:
// its fetch effect runs on mount.
const fetchOrder: string[] = [];
vi.mock('../../common', async () => {
  const { useEffect } = await import('react');
  return {
    AuthenticatedImage: ({ src, alt, queuePriority, onLoad, onError }: {
      src: string; alt: string; queuePriority?: string; onLoad?: () => void; onError?: () => void;
    }) => {
      useEffect(() => { fetchOrder.push(src); }, [src]);
      return (
        <img
          alt={alt}
          data-src={src}
          data-priority={queuePriority ?? 'normal'}
          onLoad={() => onLoad?.()}
          onError={() => onError?.()}
        />
      );
    },
  };
});
vi.mock('../PhotoFeedback', () => ({
  PhotoFeedback: ({ photoId }: { photoId: string }) => <div data-testid="feedback-panel" data-photo-id={photoId} />,
}));

import { PhotoLightbox } from '../PhotoLightbox';
import { galleryService } from '../../../services/gallery.service';
import { feedbackService } from '../../../services/feedback.service';
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
const firstFetch = (prefix: string) => fetchOrder.findIndex((src) => src.startsWith(prefix));
const strip = () => screen.getByRole('list', { name: 'Photos' });
const counter = (text: string) => screen.getByText(text);

beforeEach(() => {
  stubViewport(true);
  trackPhotoView.mockClear();
  fetchOrder.length = 0;
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

  it('asks for the open photo before any of its own thumbnails', () => {
    render(<PhotoLightbox photos={makePhotos(500)} initialIndex={250} onClose={vi.fn()} slug="g" />);
    // The strip is ahead of the slides in the document, so its effects run
    // first; six thumbnails would take every fetch slot.
    expect(fetchOrder.filter((src) => src.startsWith('/thumb/'))).toHaveLength(21);
    expect(firstFetch('/preview/251')).toBeGreaterThanOrEqual(0);
    expect(firstFetch('/preview/251')).toBeLessThan(firstFetch('/thumb/'));

    // A jump brings a new slide and new thumbnails in together.
    fetchOrder.length = 0;
    fireEvent.click(within(strip()).getByRole('button', { name: 'Photo 261 of 500' }));
    expect(fetchOrder.filter((src) => src.startsWith('/thumb/'))).toHaveLength(10);
    expect(firstFetch('/preview/261')).toBeGreaterThanOrEqual(0);
    expect(firstFetch('/preview/261')).toBeLessThan(firstFetch('/thumb/'));
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
    // The photo on screen is the visible one; its neighbours are loaded ahead, hidden.
    const shown = Array.from(standIn.children).filter((el) => (el as HTMLElement).style.visibility === 'visible');
    expect(shown).toHaveLength(1);
    expect(shown[0].querySelector('[data-src]')).toHaveAttribute('data-src', '/thumb/110');
    expect(Array.from(standIn.querySelectorAll('[data-src]')).map((el) => el.getAttribute('data-src')))
      .toEqual(['/thumb/108', '/thumb/109', '/thumb/110', '/thumb/111', '/thumb/112']);
    // Only the one on screen is fetched ahead of everything else.
    expect(Array.from(standIn.querySelectorAll('[data-src]')).map((el) => el.getAttribute('data-priority')))
      .toEqual(['prefetch', 'prefetch', 'high', 'prefetch', 'prefetch']);
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

  it('keeps the open feedback panel on the photo the scrub started from until it lands', () => {
    render(<PhotoLightbox photos={makePhotos(500)} initialIndex={100} onClose={vi.fn()} slug="g" initialShowFeedback />);
    const panelPhoto = () => screen.getByTestId('feedback-panel').getAttribute('data-photo-id');
    expect(panelPhoto()).toBe('101');

    holdKey('ArrowRight', 30);
    // The panel fetches per photo id: it is not handed the ones passed over.
    expect(counter('109 / 500')).toBeInTheDocument();
    expect(panelPhoto()).toBe('101');
    // And takes no click or key meanwhile: it would rate a photo that is not on screen.
    const panel = screen.getByTestId('feedback-panel').parentElement as HTMLElement;
    expect(panel).toHaveAttribute('inert');

    fireEvent.keyUp(document, { key: 'ArrowRight' });
    expect(panelPhoto()).toBe('109');
    expect(panel).not.toHaveAttribute('inert');
  });

  it('takes no rating, by key or by click, for a photo a scrub is passing over', async () => {
    vi.mocked(feedbackService.getGalleryFeedbackSettings).mockResolvedValueOnce({
      feedback_enabled: true, allow_ratings: true, keybind_mode: 'lightroom',
    } as never);
    const submitFeedback = vi.mocked(feedbackService.submitFeedback);
    submitFeedback.mockClear();
    render(<PhotoLightbox photos={makePhotos(500)} initialIndex={100} onClose={vi.fn()} slug="g" feedbackEnabled />);
    await act(async () => {});
    const stars = () => screen.getByLabelText('Rate photo');

    holdKey('ArrowRight', 30);
    // The stars still show the photo the scrub started from: a shortcut or a
    // click now would be worked out against that state and saved for this one.
    fireEvent.keyDown(document, { key: '3' });
    await act(async () => {});
    expect(submitFeedback).not.toHaveBeenCalled();
    expect(stars()).toHaveAttribute('inert');

    fireEvent.keyUp(document, { key: 'ArrowRight' });
    expect(stars()).not.toHaveAttribute('inert');
    fireEvent.keyDown(document, { key: '3' });
    await act(async () => {});
    expect(submitFeedback).toHaveBeenCalledTimes(1);
    expect(submitFeedback).toHaveBeenCalledWith('g', '109', expect.objectContaining({ feedback_type: 'rating', rating: 3 }));
  });

  it('leaves the carousel centred and swipeable when a scrub interrupts a committing swipe', () => {
    stubViewport(false);
    const { container } = render(<PhotoLightbox photos={makePhotos(50)} initialIndex={10} onClose={vi.fn()} slug="g" />);
    const track = () => container.querySelector('[style*="width: 300%"]') as HTMLElement;
    const surface = track().parentElement as HTMLElement;
    Object.defineProperty(surface, 'offsetWidth', { value: 800 });
    const finger = (clientX: number) => ({ clientX, clientY: 300 });
    const swipeLeft = () => {
      fireEvent.touchStart(surface, { touches: [finger(500)] });
      fireEvent.touchMove(surface, { touches: [finger(200)] });
      fireEvent.touchEnd(surface, { touches: [], changedTouches: [finger(200)] });
    };

    swipeLeft();
    expect(track().style.transform).toBe('translate3d(-66.6666%, 0, 0)');

    // The track is gone before its transition can end and reset the phase.
    fireEvent.keyDown(document, { key: 'ArrowRight', repeat: true });
    expect(track()).toBeNull();
    // A finger that lands mid-scrub has no track to drag either.
    swipeLeft();
    fireEvent.keyUp(document, { key: 'ArrowRight' });

    expect(track().style.transform).toBe('translate3d(-33.3333%, 0, 0)');
    swipeLeft();
    expect(track().style.transform).toBe('translate3d(-66.6666%, 0, 0)');
  });

  it('lets the stand-in go when the landed preview loads, or turns out not to decode', () => {
    open();
    const standIn = () => screen.queryByTestId('lightbox-scrub-stand-in');
    const preview = () => document.querySelector('[data-src^="/preview/"][data-priority="high"]') as HTMLElement;

    holdKey('ArrowRight', 10);
    fireEvent.keyUp(document, { key: 'ArrowRight' });
    expect(standIn()).not.toBeNull();
    fireEvent.load(preview());
    expect(standIn()).toBeNull();

    // The image component then shows its fallback, which reports no load:
    // the stand-in would stay underneath it for good.
    holdKey('ArrowRight', 10);
    fireEvent.keyUp(document, { key: 'ArrowRight' });
    expect(standIn()).not.toBeNull();
    fireEvent.error(preview());
    expect(standIn()).toBeNull();
  });

  it('leaves a held arrow key to the field it is typed into', () => {
    open();
    const field = document.createElement('textarea');
    document.body.appendChild(field);
    try {
      fireEvent.keyDown(field, { key: 'ArrowLeft', repeat: true });
      expect(screen.queryByTestId('lightbox-scrub-stand-in')).toBeNull();
    } finally {
      field.remove();
    }
  });

  it('does not scrub a gallery of one: there is nowhere to go, and a video would lose its place', () => {
    render(<PhotoLightbox photos={makePhotos(1)} initialIndex={0} onClose={vi.fn()} slug="g" />);
    const slide = document.querySelector('[data-src^="/preview/1?"]');
    holdKey('ArrowRight', 5);
    expect(screen.queryByTestId('lightbox-scrub-stand-in')).toBeNull();
    expect(document.querySelector('[data-src^="/preview/1?"]')).toBe(slide);
  });

  it('does not count a photo twice when a scrub ends where it began', () => {
    render(<PhotoLightbox photos={makePhotos(2)} initialIndex={0} onClose={vi.fn()} slug="g" />);
    // Two steps, 110 ms apart: on to the other photo and back again.
    holdKey('ArrowRight', 5);
    expect(counter('1 / 2')).toBeInTheDocument();
    fireEvent.keyUp(document, { key: 'ArrowRight' });
    expect(trackPhotoView.mock.calls).toEqual([['g', 1]]);
  });
});
