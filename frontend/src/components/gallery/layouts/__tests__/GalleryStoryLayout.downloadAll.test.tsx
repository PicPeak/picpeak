/**
 * Issue 1710: the only Download All in the Story layout sat in the footer,
 * after every scene. The fixed nav now carries the same action, driven by the
 * same handler, shown and hidden under the same rules.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, within, waitFor } from '@testing-library/react';

import { GalleryStoryLayout } from '../GalleryStoryLayout';
import type { Photo } from '../../../../types';

const quota = vi.hoisted(() => ({ allows: true, remaining: 10 }));
const mocks = vi.hoisted(() => ({
  showDownloadLimitReached: vi.fn(),
  downloadSelectedPhotos: vi.fn().mockResolvedValue(undefined),
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
  showDownloadLimitReached: mocks.showDownloadLimitReached,
}));
vi.mock('../../../../services/feedback.service', () => ({
  feedbackService: { submitFeedback: vi.fn().mockResolvedValue({}) },
}));
vi.mock('../../../../services/gallery.service', () => ({
  galleryService: { downloadSelectedPhotos: mocks.downloadSelectedPhotos },
}));
vi.mock('../../../../services/analytics.service', () => ({
  analyticsService: { trackGalleryEvent: vi.fn() },
}));
vi.mock('react-toastify', () => ({ toast: { info: vi.fn(), error: vi.fn() } }));

const photos: Photo[] = [1, 2, 3].map((i) => ({
  id: i,
  filename: `photo-${i}.jpg`,
  url: `/api/gallery/x/photo/${i}`,
  thumbnail_url: `/api/gallery/x/thumbnail/${i}`,
  type: 'individual',
  size: 1,
  uploaded_at: '2026-01-01T00:00:00Z',
  category_name: 'Ceremony',
} as Photo));

const baseProps = {
  photos,
  slug: 'x',
  eventName: 'Sarah & Tom',
  onPhotoClick: () => {},
  onDownload: () => {},
  selectedPhotos: new Set<number>(),
  isSelectionMode: false,
  allowDownloads: true,
} as never;

const navButton = (container: HTMLElement) =>
  within(container.querySelector('nav.story-nav') as HTMLElement).queryByRole('button', { name: 'Download All' });

beforeEach(() => {
  quota.allows = true;
  quota.remaining = 10;
  mocks.showDownloadLimitReached.mockClear();
  mocks.downloadSelectedPhotos.mockClear();
});

describe('GalleryStoryLayout Download All in the nav (issue 1710)', () => {
  it('is in the fixed nav, above the scenes, with an accessible name', () => {
    const { container } = render(<GalleryStoryLayout {...baseProps} />);
    const button = navButton(container);
    expect(button).not.toBeNull();
    expect(button).toHaveAttribute('aria-label', 'Download All');
    expect(button).toHaveAttribute('title', 'Download All');
    // The footer CTA stays as the second call to action.
    expect(container.querySelector('footer .story-footer-btn')).not.toBeNull();
    // Nav precedes the scenes in document order.
    const nav = container.querySelector('nav.story-nav') as HTMLElement;
    const main = container.querySelector('main') as HTMLElement;
    expect(nav.compareDocumentPosition(main) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('takes the whole-gallery path when the parent provides it', () => {
    const onDownloadEverything = vi.fn();
    const { container } = render(
      <GalleryStoryLayout {...baseProps} onDownloadEverything={onDownloadEverything} />
    );
    fireEvent.click(navButton(container) as HTMLElement);
    expect(onDownloadEverything).toHaveBeenCalledTimes(1);
    expect(mocks.downloadSelectedPhotos).not.toHaveBeenCalled();
  });

  it('hands off to the resolution picker when the gallery offers a choice', () => {
    const onPickResolution = vi.fn();
    const { container } = render(
      <GalleryStoryLayout
        {...baseProps}
        downloadChoices={[{ id: 'original' }, { id: '1920x1080' }] as never}
        onPickResolution={onPickResolution}
      />
    );
    fireEvent.click(navButton(container) as HTMLElement);
    expect(onPickResolution).toHaveBeenCalledWith([1, 2, 3]);
    expect(mocks.downloadSelectedPhotos).not.toHaveBeenCalled();
  });

  it('downloads the current scope when there is no picker and no whole-gallery path', async () => {
    const { container } = render(<GalleryStoryLayout {...baseProps} />);
    fireEvent.click(navButton(container) as HTMLElement);
    await waitFor(() => expect(mocks.downloadSelectedPhotos).toHaveBeenCalledWith('x', [1, 2, 3]));
  });

  it('refuses at the download limit before asking the server', () => {
    quota.allows = false;
    quota.remaining = 0;
    const { container } = render(<GalleryStoryLayout {...baseProps} />);
    fireEvent.click(navButton(container) as HTMLElement);
    expect(mocks.showDownloadLimitReached).toHaveBeenCalledWith({ remaining: 0 });
    expect(mocks.downloadSelectedPhotos).not.toHaveBeenCalled();
  });

  it('is absent when downloads are not allowed', () => {
    const { container } = render(<GalleryStoryLayout {...baseProps} allowDownloads={false} />);
    expect(navButton(container)).toBeNull();
    expect(container.querySelector('footer .story-footer-btn')).toBeNull();
  });

  it('is absent on a folder-only root with nothing downloadable', () => {
    const { container } = render(
      <GalleryStoryLayout {...baseProps} photos={[]} suppressEmptyState eventPhotoCount={12} />
    );
    expect(navButton(container)).toBeNull();
    expect(container.querySelector('footer .story-footer-btn')).toBeNull();
  });

  it('is present on a folder-only root when the whole gallery can be downloaded', () => {
    const onDownloadEverything = vi.fn();
    const { container } = render(
      <GalleryStoryLayout
        {...baseProps}
        photos={[]}
        suppressEmptyState
        eventPhotoCount={12}
        onDownloadEverything={onDownloadEverything}
      />
    );
    fireEvent.click(navButton(container) as HTMLElement);
    expect(onDownloadEverything).toHaveBeenCalledTimes(1);
  });
});
