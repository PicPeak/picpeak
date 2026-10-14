/**
 * A dialog the Story layout opened before its lightbox mounts keeps its keys
 * (issue 1973).
 *
 * Browser Forward can bring a photo back while the name-and-e-mail prompt
 * from a card's like is still open. The layout renders the prompt after the
 * lightbox, so the prompt paints on top; the lightbox, mounting last, took
 * the top of the dialog stack all the same, and Escape closed the lightbox
 * behind the prompt while the prompt stayed.
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

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
// The real lightbox and the real identity prompt; only the image is stubbed.
vi.mock('../../../common', async () => ({
  Button: (await import('../../../common/Button')).Button,
  Input: (await import('../../../common/Input')).Input,
  AuthenticatedImage: ({ alt }: { alt?: string }) => <img alt={alt} />,
  PoweredBy: () => null,
}));
vi.mock('../../../../hooks/useDevToolsProtection', () => ({ useDevToolsProtection: () => undefined }));
vi.mock('../../../../hooks/useGallery', () => ({ useSavePhotoToDevice: () => ({ mutate: vi.fn(), isPending: false }) }));
vi.mock('../../../../services/feedback.service', () => ({
  feedbackService: {
    getGalleryFeedbackSettings: vi.fn().mockResolvedValue({ feedback_enabled: false }),
    getPhotoFeedback: vi.fn().mockResolvedValue({ feedback: [], my_feedback: {}, summary: {} }),
    submitFeedback: vi.fn().mockResolvedValue({}),
  },
}));
vi.mock('../../../../services/gallery.service', () => ({
  galleryService: { downloadSelectedPhotos: vi.fn(), trackPhotoView: vi.fn() },
}));
vi.mock('../../../../services/analytics.service', () => ({
  analyticsService: { trackGalleryEvent: vi.fn() },
}));
vi.mock('react-toastify', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });

const photos: Photo[] = [1, 2, 3].map((i) => ({
  id: i,
  filename: `IMG_${i}.jpg`,
  url: `/api/gallery/x/photo/${i}`,
  thumbnail_url: `/api/gallery/x/thumbnail/${i}`,
  type: 'individual',
  size: 1,
  uploaded_at: '2026-01-01T00:00:00Z',
  category_name: 'Ceremony',
} as Photo));

describe('GalleryStoryLayout — a dialog open before the lightbox mounts', () => {
  it('keeps Escape and the arrows while the lightbox comes back under it', () => {
    const onLightboxPhotoChange = vi.fn();
    const props = {
      photos,
      slug: 'x',
      eventName: 'Sarah & Tom',
      onPhotoClick: () => {},
      onDownload: () => {},
      selectedPhotos: new Set<number>(),
      isSelectionMode: false,
      allowDownloads: true,
      feedbackEnabled: true,
      feedbackOptions: { requireNameEmail: true, allowLikes: true },
      onLightboxPhotoChange,
    };
    const client = new QueryClient();
    const view = (openPhotoId?: number | null) => (
      <QueryClientProvider client={client}>
        <GalleryStoryLayout {...(props as never)} openPhotoId={openPhotoId} />
      </QueryClientProvider>
    );
    const { container, rerender } = render(view(undefined));

    // A card's like asks for name and e-mail first.
    fireEvent.click(container.querySelector('.story-photo-card-actions button')!);
    const prompt = screen.getByRole('dialog', { name: /./ });
    expect(prompt).toBeInTheDocument();

    // Browser Forward brings photo 2 back while the prompt is open.
    rerender(view(2));
    expect(document.querySelector('.fixed.inset-0.bg-black')).not.toBeNull();

    fireEvent.keyDown(prompt, { key: 'ArrowRight' });
    expect(onLightboxPhotoChange).not.toHaveBeenCalledWith(3, 'step');

    // Escape closes the prompt on top, not the lightbox under it.
    fireEvent.keyDown(prompt, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: /./ })).toBeNull();
    expect(onLightboxPhotoChange).not.toHaveBeenCalledWith(null, 'close');

    // With the prompt gone the lightbox has its keys back.
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onLightboxPhotoChange).toHaveBeenCalledWith(null, 'close');
  });
});
