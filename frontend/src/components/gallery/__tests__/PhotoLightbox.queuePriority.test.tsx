/**
 * The lightbox mounts three slides (previous, current, next) and each one
 * fetches through the shared image queue. The tier it asks for decides which
 * loads first once the queue is backed up:
 *  - the slide on screen is `high`
 *  - the two neighbours are `prefetch`, so they never take a freed slot ahead
 *    of the image the guest is looking at
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
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
  AuthenticatedImage: ({ alt, queuePriority }: { alt: string; queuePriority?: string }) => (
    <img alt={alt} data-priority={queuePriority ?? 'normal'} />
  ),
}));

import { PhotoLightbox } from '../PhotoLightbox';

vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });

const photos = [1, 2, 3].map((id) => ({ id, filename: `photo-${id}`, url: `/p/${id}`, thumbnail_url: `/t/${id}` } as Photo));
const priorityOf = (filename: string) => screen.getByAltText(filename).getAttribute('data-priority');

describe('PhotoLightbox image queue priority', () => {
  it('fetches the slide on screen as high and its neighbours as prefetch', () => {
    render(<PhotoLightbox photos={photos} initialIndex={1} onClose={vi.fn()} slug="g" />);

    expect(priorityOf('photo-2')).toBe('high');
    expect(priorityOf('photo-1')).toBe('prefetch');
    expect(priorityOf('photo-3')).toBe('prefetch');
  });

  it('follows the opening index, not the slot order', () => {
    render(<PhotoLightbox photos={photos} initialIndex={0} onClose={vi.fn()} slug="g" />);

    expect(priorityOf('photo-1')).toBe('high');
    expect(priorityOf('photo-2')).toBe('prefetch');
    expect(priorityOf('photo-3')).toBe('prefetch');
  });

  // The neighbour was prefetched so that stepping onto it shows a loaded
  // picture. That only holds while React keeps the same image instance: a
  // remount aborts the fetch (or drops the loaded blob) and starts over.
  it('keeps a prefetched neighbour mounted when it becomes the slide on screen', () => {
    render(<PhotoLightbox photos={photos} initialIndex={0} onClose={vi.fn()} slug="g" />);
    const next = screen.getByAltText('photo-2');
    const current = screen.getByAltText('photo-1');

    act(() => { fireEvent.keyDown(document, { key: 'ArrowRight' }); });

    expect(priorityOf('photo-2')).toBe('high');
    expect(screen.getByAltText('photo-2')).toBe(next);
    // And the one stepped away from stays for the way back.
    expect(screen.getByAltText('photo-1')).toBe(current);
  });
});
