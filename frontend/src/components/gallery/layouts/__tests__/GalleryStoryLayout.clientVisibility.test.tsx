/**
 * Issue 1992: the Story layout's cards (fixed grid, natural grid and the
 * carousel scene) had no client hide/show button. The card's checkbox owns
 * top-left, so the button sits below it; the click must not open the photo.
 */
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

import { GalleryStoryLayout } from '../GalleryStoryLayout';
import type { Photo } from '../../../../types';

const quota = vi.hoisted(() => ({ allows: true, remaining: 10 }));
const mocks = vi.hoisted(() => ({
  submitFeedback: vi.fn().mockResolvedValue({}),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  ensureIdentity: vi.fn().mockResolvedValue({}),
}));
const identity = vi.hoisted(() => ({ mode: 'simple' as 'simple' | 'guest' }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: unknown) => (typeof fallback === 'string' ? fallback : key),
  }),
}));

vi.mock('framer-motion', () => {
  const stub = (tag: string) =>
    React.forwardRef<HTMLElement, Record<string, unknown>>(({ children, className, onClick }, ref) =>
      React.createElement(tag, { ref, className, onClick }, children as React.ReactNode)
    );
  return {
    motion: new Proxy({} as Record<string, unknown>, {
      get: (cache, tag: string) => (cache[tag] ??= stub(tag)),
    }),
    AnimatePresence: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
    useInView: () => true,
  };
});

vi.mock('swiper/react', () => ({
  Swiper: ({ children }: { children?: React.ReactNode }) => <div data-testid="swiper">{children}</div>,
  SwiperSlide: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('swiper/modules', () => ({ FreeMode: {}, Mousewheel: {} }));
vi.mock('swiper/css', () => ({}));
vi.mock('swiper/css/free-mode', () => ({}));

vi.mock('../../../common', () => ({
  AuthenticatedImage: ({ src, alt }: { src: string; alt?: string }) => <img src={src} alt={alt} />,
  PoweredBy: () => null,
}));
vi.mock('../../PhotoLightbox', () => ({
  PhotoLightbox: ({ onFeedbackChange }: { onFeedbackChange?: () => void }) => (
    <button data-testid="lightbox" onClick={onFeedbackChange}>lightbox</button>
  ),
}));
vi.mock('../../FeedbackIdentityModal', () => ({
  FeedbackIdentityModal: ({ isOpen, onSubmit, onClose }: { isOpen: boolean; onSubmit: (n: string, e: string) => void; onClose: () => void }) =>
    isOpen ? (
      <div>
        <button data-testid="identity-modal" onClick={() => onSubmit('Ann', 'ann@example.com')}>submit</button>
        <button data-testid="identity-modal-close" onClick={onClose}>close</button>
      </div>
    ) : null,
}));
vi.mock('../../../../contexts/GuestIdentityContext', () => ({
  useGuestIdentityOptional: () =>
    identity.mode === 'guest' ? { identityMode: 'guest', ensureIdentity: mocks.ensureIdentity } : null,
}));
vi.mock('../../DownloadQuotaNotice', () => ({ DownloadQuotaNotice: () => null }));
vi.mock('../../../../contexts/DownloadQuotaContext', () => ({
  useDownloadQuota: () => ({ allows: () => quota.allows, remaining: quota.remaining }),
}));
vi.mock('../../../../utils/downloadLimit', () => ({
  isDownloadLimitError: () => false,
  showDownloadLimitReached: vi.fn(),
}));
vi.mock('../../../../services/feedback.service', async (importOriginal) => ({
  // The real swatches: the colour-label dot renders from them.
  ...(await importOriginal<typeof import('../../../../services/feedback.service')>()),
  feedbackService: { submitFeedback: mocks.submitFeedback },
}));
vi.mock('../../../../services/gallery.service', () => ({
  galleryService: { downloadSelectedPhotos: vi.fn() },
}));
vi.mock('../../../../services/analytics.service', () => ({
  analyticsService: { trackGalleryEvent: vi.fn() },
}));
vi.mock('react-toastify', () => ({
  toast: { info: vi.fn(), error: mocks.toastError, success: mocks.toastSuccess },
}));

const photo = (id: number, extra: Partial<Photo>): Photo => ({
  id,
  filename: `photo-${id}.jpg`,
  original_filename: `photo-${id}.jpg`,
  url: `/api/gallery/x/photo/${id}`,
  thumbnail_url: `/api/gallery/x/thumbnail/${id}`,
  type: 'individual',
  size: 1,
  uploaded_at: '2026-01-01T00:00:00Z',
  width: 3000,
  height: 2000,
  ...extra,
} as Photo);

// Two categories: the first scene is a grid, the second a carousel.
const photos = [
  photo(1, { category_name: 'Ceremony', visibility: 'visible', my_color_label: 'red' }),
  photo(2, { category_name: 'Ceremony', visibility: 'hidden' }),
  photo(3, { category_name: 'Party', visibility: 'hidden' }),
];

const baseProps = {
  photos,
  slug: 'x',
  eventName: 'Sarah & Tom',
  onPhotoClick: () => {},
  onDownload: () => {},
  isSelectionMode: false,
  selectedPhotos: new Set<number>(),
  allowDownloads: true,
  feedbackEnabled: true,
} as never;

const cardLink = (container: HTMLElement, id: number) =>
  container.querySelector(`a[data-photo-id="${id}"]`) as HTMLAnchorElement;

afterEach(() => cleanup());

describe.each(['fixed', 'natural'] as const)('GalleryStoryLayout (%s grid): client visibility toggle (issue 1992)', (storyGridMode) => {
  it('renders the toggle on every card, grid and carousel scenes alike', () => {
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => 1200 });
    const { container } = render(
      <GalleryStoryLayout {...baseProps} storyGridMode={storyGridMode} isClient onToggleVisibility={vi.fn()} />,
    );
    const visible = screen.getByTestId('client-visibility-toggle-1');
    expect(visible).toHaveAttribute('aria-label', 'Visible to guests');
    expect(visible).toHaveAttribute('aria-pressed', 'false');
    expect(visible.className).toContain('top-12 left-3');
    expect(screen.getByTestId('client-visibility-toggle-2')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('client-visibility-toggle-3')).toHaveAttribute('aria-label', 'Hidden from guests');

    expect(cardLink(container, 2).className).toContain('opacity-40');
    expect(cardLink(container, 3).className).toContain('opacity-40');
    expect(cardLink(container, 1).className).not.toContain('opacity-40');
    // The dim is on the card's link, which holds the image only: the eye
    // sits outside it, at full strength.
    expect(cardLink(container, 2).contains(screen.getByTestId('client-visibility-toggle-2'))).toBe(false);
    // The eye sits below the checkbox, clear of the colour-label dot, so the
    // dot keeps its corner.
    const dot = container.querySelector('[aria-label^="Marked as"]') as HTMLElement;
    expect(dot.parentElement!.className).toContain('absolute top-2 left-2');
  });

  it('toggles without opening the photo', () => {
    const onToggleVisibility = vi.fn();
    render(<GalleryStoryLayout {...baseProps} storyGridMode={storyGridMode} isClient onToggleVisibility={onToggleVisibility} />);
    fireEvent.click(screen.getByTestId('client-visibility-toggle-3'));
    expect(onToggleVisibility).toHaveBeenCalledWith(3, 'hidden');
    expect(screen.queryByTestId('lightbox')).toBeNull();
  });

  it('shows no toggle for a guest', () => {
    const { container } = render(
      <GalleryStoryLayout {...baseProps} storyGridMode={storyGridMode} onToggleVisibility={vi.fn()} />,
    );
    expect(screen.queryByTestId('client-visibility-toggle-1')).toBeNull();
    expect(cardLink(container, 2).className).not.toContain('opacity-40');
  });
});
