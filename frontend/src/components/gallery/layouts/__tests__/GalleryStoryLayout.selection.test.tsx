/**
 * Issue 1716: selection mode on the Story layout. The container owns the
 * mode, the set and the selection download; this layout renders the Select
 * control, the selection bar and the card checkboxes, and asks the container
 * for every change. Favourite selected talks to the per-photo like toggle
 * only for the photos that need to change.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { GalleryStoryLayout } from '../GalleryStoryLayout';
import type { Photo } from '../../../../types';

const quota = vi.hoisted(() => ({ allows: true, remaining: 10 }));
const mocks = vi.hoisted(() => ({
  submitFeedback: vi.fn().mockResolvedValue({}),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

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
vi.mock('../../PhotoLightbox', () => ({ PhotoLightbox: () => <div data-testid="lightbox" /> }));
vi.mock('../../DownloadQuotaNotice', () => ({ DownloadQuotaNotice: () => null }));
vi.mock('../../../../contexts/DownloadQuotaContext', () => ({
  useDownloadQuota: () => ({ allows: () => quota.allows, remaining: quota.remaining }),
}));
vi.mock('../../../../utils/downloadLimit', () => ({
  isDownloadLimitError: () => false,
  showDownloadLimitReached: vi.fn(),
}));
vi.mock('../../../../services/feedback.service', () => ({
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

const photo = (id: number, extra: Partial<Photo> = {}): Photo => ({
  id,
  filename: `photo-${id}.jpg`,
  original_filename: `photo-${id}.jpg`,
  url: `/api/gallery/x/photo/${id}`,
  thumbnail_url: `/api/gallery/x/thumbnail/${id}`,
  type: 'individual',
  size: 1,
  uploaded_at: '2026-01-01T00:00:00Z',
  category_name: 'Ceremony',
  width: 3000,
  height: 2000,
  ...extra,
} as Photo);

const photos = [photo(1, { is_liked: true }), photo(2), photo(3)];

const handlers = () => ({
  onToggleSelectionMode: vi.fn(),
  onPhotoSelect: vi.fn(),
  onSelectMany: vi.fn(),
  onDeselectAll: vi.fn(),
  onDownloadSelected: vi.fn(),
  onFeedbackChange: vi.fn(),
});

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

const nav = (container: HTMLElement) => within(container.querySelector('nav.story-nav') as HTMLElement);
const selectButton = (container: HTMLElement) => nav(container).queryByTestId('story-nav-select');
const bar = (container: HTMLElement) => container.querySelector('.story-selection-bar') as HTMLElement | null;
const cardLink = (container: HTMLElement, id: number) =>
  container.querySelector(`a[data-photo-id="${id}"]`) as HTMLAnchorElement;

beforeEach(() => {
  quota.allows = true;
  quota.remaining = 10;
  mocks.submitFeedback.mockClear();
  mocks.toastSuccess.mockClear();
  mocks.toastError.mockClear();
});

describe('GalleryStoryLayout selection mode (issue 1716)', () => {
  it('shows the Select control in the nav only when there is something to select and a container to talk to', () => {
    const h = handlers();
    const withMany = render(<GalleryStoryLayout {...baseProps} {...h} />);
    expect(selectButton(withMany.container)).not.toBeNull();
    expect(selectButton(withMany.container)).toHaveAttribute('aria-label', 'Select Photos');
    withMany.unmount();

    const single = render(<GalleryStoryLayout {...baseProps} {...h} photos={[photo(1)]} />);
    expect(selectButton(single.container)).toBeNull();
    single.unmount();

    const { onToggleSelectionMode: _omit, ...withoutToggle } = h;
    void _omit;
    const noContainer = render(<GalleryStoryLayout {...baseProps} {...withoutToggle} />);
    expect(selectButton(noContainer.container)).toBeNull();
    expect(bar(noContainer.container)).toBeNull();
  });

  it('asks the container to enter selection mode, and clears then leaves it on cancel', () => {
    const h = handlers();
    const off = render(<GalleryStoryLayout {...baseProps} {...h} />);
    expect(bar(off.container)).toBeNull();
    fireEvent.click(selectButton(off.container) as HTMLElement);
    expect(h.onToggleSelectionMode).toHaveBeenCalledTimes(1);
    expect(h.onDeselectAll).not.toHaveBeenCalled();
    off.unmount();

    const on = render(<GalleryStoryLayout {...baseProps} {...h} isSelectionMode selectedPhotos={new Set([2])} />);
    expect(bar(on.container)).not.toBeNull();
    expect(selectButton(on.container)).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(within(bar(on.container) as HTMLElement).getByRole('button', { name: 'Cancel Selection' }));
    expect(h.onDeselectAll).toHaveBeenCalledTimes(1);
    expect(h.onToggleSelectionMode).toHaveBeenCalledTimes(2);
  });

  it('turns every card into a toggle while selecting and never opens the lightbox', () => {
    const h = handlers();
    const { container } = render(
      <GalleryStoryLayout {...baseProps} {...h} isSelectionMode selectedPhotos={new Set([2])} />
    );
    fireEvent.click(cardLink(container, 1));
    expect(h.onPhotoSelect).toHaveBeenCalledWith(1);
    expect(screen.queryByTestId('lightbox')).toBeNull();

    const checkboxes = container.querySelectorAll('[role="checkbox"]');
    expect(checkboxes).toHaveLength(3);
    const selectedCard = cardLink(container, 2).closest('.story-photo-card') as HTMLElement;
    expect(selectedCard.classList.contains('selected')).toBe(true);
    expect(within(selectedCard).getByRole('checkbox')).toHaveAttribute('aria-checked', 'true');
    expect(within(selectedCard).getByRole('checkbox')).toHaveAttribute('aria-label', 'photo-2.jpg');
    fireEvent.click(within(selectedCard).getByRole('checkbox'));
    expect(h.onPhotoSelect).toHaveBeenLastCalledWith(2);
    expect(h.onPhotoSelect).toHaveBeenCalledTimes(2);
  });

  it('opens the lightbox as before outside selection mode, and the hover checkbox starts a selection', () => {
    const h = handlers();
    const { container } = render(<GalleryStoryLayout {...baseProps} {...h} />);
    fireEvent.click(cardLink(container, 1));
    expect(screen.getByTestId('lightbox')).toBeInTheDocument();
    expect(h.onPhotoSelect).not.toHaveBeenCalled();
    const check = container.querySelector('[role="checkbox"]') as HTMLElement;
    expect(check.classList.contains('visible')).toBe(false);
    fireEvent.click(check);
    expect(h.onPhotoSelect).toHaveBeenCalledWith(1);
  });

  it('puts checkboxes on carousel and natural-grid cards too', () => {
    // The justified grid lays out from the measured width, which jsdom reports as 0.
    const originalOffsetWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth');
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => 1200 });
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} });
    try {
      const h = handlers();
      const twoScenes = [...photos, photo(4, { category_name: 'Party' }), photo(5, { category_name: 'Party' })];
      const { container } = render(
        <GalleryStoryLayout {...baseProps} {...h} photos={twoScenes} isSelectionMode storyGridMode="natural" />
      );
      expect(container.querySelectorAll('.story-gallery-justified-box [role="checkbox"]')).toHaveLength(3);
      expect(container.querySelectorAll('.story-carousel-item [role="checkbox"]')).toHaveLength(2);
    } finally {
      if (originalOffsetWidth) Object.defineProperty(HTMLElement.prototype, 'offsetWidth', originalOffsetWidth);
      vi.unstubAllGlobals();
    }
  });

  it('select all covers the photos the search shows, in one call; deselect all when they are all selected', () => {
    const h = handlers();
    const { container } = render(<GalleryStoryLayout {...baseProps} {...h} isSelectionMode />);
    fireEvent.change(screen.getByPlaceholderText('Search memories...'), { target: { value: 'photo-2' } });
    fireEvent.click(within(bar(container) as HTMLElement).getByRole('button', { name: 'Select All' }));
    expect(h.onSelectMany).toHaveBeenCalledWith([2]);
    expect(h.onPhotoSelect).not.toHaveBeenCalled();

    const all = render(
      <GalleryStoryLayout {...baseProps} {...h} isSelectionMode selectedPhotos={new Set([1, 2, 3])} />
    );
    fireEvent.click(within(bar(all.container) as HTMLElement).getByRole('button', { name: 'Deselect All' }));
    expect(h.onDeselectAll).toHaveBeenCalledTimes(1);
  });

  it('download selected goes through the container handler and respects the download limit', () => {
    const h = handlers();
    const { container } = render(
      <GalleryStoryLayout {...baseProps} {...h} isSelectionMode selectedPhotos={new Set([1, 2])} />
    );
    const button = within(bar(container) as HTMLElement).getByTestId('story-download-selected');
    expect(button).toHaveTextContent('gallery.downloadSelected');
    fireEvent.click(button);
    expect(h.onDownloadSelected).toHaveBeenCalledTimes(1);
  });

  it('download selected is disabled at the limit and absent when downloads are off or nothing is selected', () => {
    const h = handlers();
    quota.allows = false;
    const limited = render(
      <GalleryStoryLayout {...baseProps} {...h} isSelectionMode selectedPhotos={new Set([1, 2])} />
    );
    expect(within(bar(limited.container) as HTMLElement).getByTestId('story-download-selected')).toBeDisabled();
    limited.unmount();
    quota.allows = true;

    const off = render(
      <GalleryStoryLayout {...baseProps} {...h} isSelectionMode selectedPhotos={new Set([1])} allowDownloads={false} />
    );
    expect(within(bar(off.container) as HTMLElement).queryByTestId('story-download-selected')).toBeNull();
    off.unmount();

    const empty = render(<GalleryStoryLayout {...baseProps} {...h} isSelectionMode />);
    expect(within(bar(empty.container) as HTMLElement).queryByTestId('story-download-selected')).toBeNull();
    expect(within(bar(empty.container) as HTMLElement).queryByTestId('story-favorite-selected')).toBeNull();
  });

  it('favourite selected likes only the photos that are not liked yet, then notifies once', async () => {
    const h = handlers();
    const { container } = render(
      <GalleryStoryLayout {...baseProps} {...h} isSelectionMode selectedPhotos={new Set([1, 2, 3])} />
    );
    const button = within(bar(container) as HTMLElement).getByTestId('story-favorite-selected');
    expect(button).toHaveTextContent('gallery.favoriteSelected');
    fireEvent.click(button);
    await waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalledWith('gallery.favoritesAdded'));
    // Photo 1 arrived liked (is_liked), so the toggle is sent for 2 and 3 only.
    expect(mocks.submitFeedback.mock.calls.map((call) => call[1]).sort()).toEqual(['2', '3']);
    expect(mocks.submitFeedback).toHaveBeenCalledWith('x', '2', { feedback_type: 'like' });
    expect(h.onFeedbackChange).toHaveBeenCalledTimes(1);
    // The card hearts follow.
    const heart = cardLink(container, 2).closest('.story-photo-card')?.querySelector('.story-photo-card-btn');
    expect(heart?.classList.contains('favorite')).toBe(true);
  });

  it('a selection that is liked throughout is unliked by the same control', async () => {
    const h = handlers();
    const { container } = render(
      <GalleryStoryLayout {...baseProps} {...h} isSelectionMode selectedPhotos={new Set([1])} />
    );
    const button = within(bar(container) as HTMLElement).getByTestId('story-favorite-selected');
    expect(button).toHaveTextContent('gallery.unfavoriteSelected');
    fireEvent.click(button);
    await waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalledWith('gallery.favoritesRemoved'));
    expect(mocks.submitFeedback).toHaveBeenCalledTimes(1);
    expect(mocks.submitFeedback).toHaveBeenCalledWith('x', '1', { feedback_type: 'like' });
  });

  it('reports a partial failure and keeps the successful likes', async () => {
    const h = handlers();
    mocks.submitFeedback
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('nope'));
    const { container } = render(
      <GalleryStoryLayout {...baseProps} {...h} isSelectionMode selectedPhotos={new Set([2, 3])} />
    );
    fireEvent.click(within(bar(container) as HTMLElement).getByTestId('story-favorite-selected'));
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith('gallery.favoriteSelectedError'));
    expect(mocks.toastSuccess).toHaveBeenCalledWith('gallery.favoritesAdded');
    expect(h.onFeedbackChange).toHaveBeenCalledTimes(1);
  });

  it('hides favourite selected when feedback is disabled', () => {
    const h = handlers();
    const { container } = render(
      <GalleryStoryLayout {...baseProps} {...h} isSelectionMode selectedPhotos={new Set([1])} feedbackEnabled={false} />
    );
    expect(within(bar(container) as HTMLElement).queryByTestId('story-favorite-selected')).toBeNull();
    expect(within(bar(container) as HTMLElement).getByTestId('story-download-selected')).toBeInTheDocument();
  });

  it('is wired to the container: mode toggle, additive select and the shared selection download', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/components/gallery/PhotoGridWithLayouts.tsx'), 'utf8');
    expect(source).toMatch(/onToggleSelectionMode:\s*toggleSelectionMode/);
    expect(source).toMatch(/onSelectMany:\s*selectMany/);
    expect(source).toMatch(/onDownloadSelected:\s*handleDownloadSelected/);
  });
});
