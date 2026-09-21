/**
 * Pinch-zoom in the lightbox flickered in touchscreen Safari. The contracts
 * that keep it steady, exercised through real touch events:
 *  - no transform transition (and an own compositor layer) while fingers
 *    drive the image; the easing comes back when they lift
 *  - the first finger of a pinch does not drag the carousel track
 *  - the image's bubbling transitionend cannot end the track's spring early
 *  - native page zoom is off for the whole lightbox
 */
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Photo } from '../../../types';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string, d?: unknown) => (typeof d === 'string' ? d : k) }) }));
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
  AuthenticatedImage: ({ alt, style }: { alt: string; style?: React.CSSProperties }) => <img alt={alt} style={style} />,
}));

import { PhotoLightbox } from '../PhotoLightbox';

vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });

const photos = [1, 2, 3].map((id) => ({ id, filename: `photo-${id}`, url: `/p/${id}`, thumbnail_url: `/t/${id}` } as Photo));
const finger = (clientX: number, clientY = 300) => ({ clientX, clientY });

// jsdom has no TransitionEvent, so fireEvent.transitionEnd drops propertyName
// and the handler would bail before reaching the check under test.
const transformTransitionEnd = (el: Element) => {
  const event = new Event('transitionend', { bubbles: true });
  Object.defineProperty(event, 'propertyName', { value: 'transform' });
  fireEvent(el, event);
};

const setup = () => {
  const { container } = render(<PhotoLightbox photos={photos} initialIndex={1} onClose={vi.fn()} slug="g" />);
  const image = () => screen.getByAltText('photo-2');
  // image → slide → track → the container carrying the touch handlers.
  const track = image().parentElement!.parentElement as HTMLElement;
  const surface = track.parentElement as HTMLElement;
  return { root: container.firstElementChild as HTMLElement, image, surface, track };
};

describe('PhotoLightbox pinch-zoom', () => {
  it('drops the transform transition and takes its own layer while pinching', () => {
    const { image, surface } = setup();
    expect(image().style.transition).toBe('transform 0.2s');

    fireEvent.touchStart(surface, { touches: [finger(100), finger(200)] });
    fireEvent.touchMove(surface, { touches: [finger(50), finger(250)] });
    expect(image().style.transform).toContain('scale(2)');
    expect(image().style.transition).toBe('none');
    expect(image().style.willChange).toBe('transform');

    fireEvent.touchEnd(surface, { touches: [finger(50)], changedTouches: [finger(250)] });
    expect(image().style.transition).toBe('transform 0.2s');
    expect(image().style.willChange).toBe('');
    expect(image().style.transform).toContain('scale(2)');
  });

  it('chains touchmoves that land before a render off each other', () => {
    const { image, surface } = setup();
    fireEvent.touchStart(surface, { touches: [finger(100), finger(200)] });
    fireEvent.touchMove(surface, { touches: [finger(75), finger(225)] });
    fireEvent.touchMove(surface, { touches: [finger(50), finger(250)] });
    expect(image().style.transform).toContain('scale(2)');
  });

  it('re-baselines when a third finger lifts mid-pinch', () => {
    const { image, surface } = setup();
    fireEvent.touchStart(surface, { touches: [finger(100), finger(200)] });
    fireEvent.touchMove(surface, { touches: [finger(50), finger(250)] });
    // Palm lands and lifts; the surviving pair is further apart.
    fireEvent.touchEnd(surface, { touches: [finger(50), finger(350)], changedTouches: [finger(250)] });
    fireEvent.touchMove(surface, { touches: [finger(50), finger(350)] });
    expect(image().style.transform).toContain('scale(2)');
    // …and the pinch is still live for the surviving pair.
    fireEvent.touchMove(surface, { touches: [finger(50), finger(500)] });
    expect(image().style.transform).toContain('scale(3)');
  });

  it('does not drag the carousel with the first finger of a pinch', () => {
    const { surface, track } = setup();
    fireEvent.touchStart(surface, { touches: [finger(100)] });
    fireEvent.touchMove(surface, { touches: [finger(105)] });
    expect(track.style.transform).toBe('translate3d(calc(-33.3333% + 0px), 0, 0)');

    fireEvent.touchStart(surface, { touches: [finger(105), finger(200)] });
    // Nothing to spring back from: straight to idle, no track transition.
    expect(track.style.transform).toBe('translate3d(-33.3333%, 0, 0)');
    expect(track.style.transition).toBe('none');
  });

  it('still follows a real swipe, minus the slop', () => {
    const { surface, track } = setup();
    fireEvent.touchStart(surface, { touches: [finger(200)] });
    fireEvent.touchMove(surface, { touches: [finger(150)] });
    expect(track.style.transform).toBe('translate3d(calc(-33.3333% + -42px), 0, 0)');
  });

  it('ignores a transitionend bubbling up from the image while the track springs back', () => {
    const { image, surface, track } = setup();
    fireEvent.touchStart(surface, { touches: [finger(200)] });
    fireEvent.touchMove(surface, { touches: [finger(170)] });
    fireEvent.touchEnd(surface, { touches: [], changedTouches: [finger(170)] });
    expect(track.style.transition).toContain('280ms');

    transformTransitionEnd(image());
    expect(track.style.transition).toContain('280ms');

    transformTransitionEnd(track);
    expect(track.style.transition).toBe('none');
  });

  it('turns native page zoom off for the whole lightbox', () => {
    Object.defineProperty(navigator, 'maxTouchPoints', { value: 5, configurable: true });
    const { root } = setup();
    expect(root.style.touchAction).toBe('pan-x pan-y');
    const gesture = new Event('gesturestart', { bubbles: true, cancelable: true });
    root.querySelector('button')!.dispatchEvent(gesture);
    expect(gesture.defaultPrevented).toBe(true);
  });
});
