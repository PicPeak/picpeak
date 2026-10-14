/**
 * Guest upload in the Story layout. It renders no gallery header, the only
 * place the other layouts offer the upload button, so the fixed nav carries
 * it — and the empty state too, since an upload-only gallery starts empty.
 */
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, fireEvent, within, cleanup } from '@testing-library/react';

import { GalleryStoryLayout } from '../GalleryStoryLayout';
import type { Photo } from '../../../../types';

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
  Button: ({ children, onClick }: { children?: React.ReactNode; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>{children}</button>
  ),
}));
vi.mock('../../PhotoLightbox', () => ({ PhotoLightbox: () => null }));
vi.mock('../../DownloadQuotaNotice', () => ({ DownloadQuotaNotice: () => null }));
vi.mock('../../../../contexts/DownloadQuotaContext', () => ({
  useDownloadQuota: () => ({ allows: () => true, remaining: 10 }),
}));
vi.mock('../../../../services/feedback.service', () => ({
  feedbackService: { submitFeedback: vi.fn().mockResolvedValue({}) },
}));
vi.mock('../../../../services/gallery.service', () => ({ galleryService: {} }));
vi.mock('../../../../services/analytics.service', () => ({
  analyticsService: { trackGalleryEvent: vi.fn() },
}));
vi.mock('react-toastify', () => ({ toast: { info: vi.fn(), error: vi.fn() } }));

const photos: Photo[] = [1, 2].map((i) => ({
  id: i,
  filename: `photo-${i}.jpg`,
  url: `/api/gallery/x/photo/${i}`,
  thumbnail_url: `/api/gallery/x/thumbnail/${i}`,
  type: 'individual',
  size: 1,
  uploaded_at: '2026-01-01T00:00:00Z',
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

const nav = (container: HTMLElement) => within(container.querySelector('nav.story-nav') as HTMLElement);

afterEach(cleanup);

describe('GalleryStoryLayout guest upload', () => {
  it('has no upload button when uploads are off', () => {
    const { container } = render(<GalleryStoryLayout {...baseProps} />);
    expect(nav(container).queryByRole('button', { name: 'Upload Photos' })).toBeNull();
  });

  it('puts a labelled upload button in the nav that opens the dialog', () => {
    const onUploadClick = vi.fn();
    const { container } = render(<GalleryStoryLayout {...baseProps} onUploadClick={onUploadClick} />);
    const button = nav(container).getByRole('button', { name: 'Upload Photos' });
    expect(button).toHaveAttribute('title', 'Upload Photos');
    expect(button).toHaveClass('story-nav-btn');
    fireEvent.click(button);
    expect(onUploadClick).toHaveBeenCalledTimes(1);
  });

  it('offers the upload in an empty gallery, which has no nav', () => {
    const onUploadClick = vi.fn();
    const { getByRole, container } = render(
      <GalleryStoryLayout {...baseProps} photos={[]} onUploadClick={onUploadClick} />
    );
    expect(container.querySelector('nav.story-nav')).toBeNull();
    fireEvent.click(getByRole('button', { name: 'Upload Photos' }));
    expect(onUploadClick).toHaveBeenCalledTimes(1);
  });

  it('shows no upload in an empty gallery when uploads are off', () => {
    const { queryByRole } = render(<GalleryStoryLayout {...baseProps} photos={[]} />);
    expect(queryByRole('button', { name: 'Upload Photos' })).toBeNull();
  });
});
