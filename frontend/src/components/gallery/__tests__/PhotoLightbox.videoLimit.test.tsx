/**
 * Download limit (issue 1560): playing a video streams its original, which on
 * a limited gallery takes a slot like a download. The lightbox
 *  - shows the limit message instead of a broken player for a video not yet
 *    granted once no slot is left, and for a share-link guest, who never
 *    draws on the quota
 *  - otherwise loads the player with preload="none", so opening the lightbox
 *    does not take the slot; only pressing Play does
 */
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
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
  AuthenticatedImage: ({ alt }: { alt: string }) => <img alt={alt} />,
}));
vi.mock('react-toastify', () => ({ toast: { error: vi.fn() } }));

import { PhotoLightbox } from '../PhotoLightbox';
import { DownloadQuotaProvider } from '../../../contexts/DownloadQuotaContext';

vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });

const video = (over: Partial<Photo> = {}) => ({
  id: 5, filename: 'clip.mp4', url: '/api/gallery/g/photo/5', thumbnail_url: '/t/5', media_type: 'video', ...over,
} as Photo);

function renderLightbox(photo: Photo, event: Record<string, unknown>) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <DownloadQuotaProvider slug="g" event={event as never}>
        <PhotoLightbox photos={[photo]} initialIndex={0} onClose={vi.fn()} slug="g" />
      </DownloadQuotaProvider>
    </QueryClientProvider>,
  );
}

describe('PhotoLightbox video on a limited gallery (issue 1560)', () => {
  it('shows the limit message once no slot is left for a video not yet granted', () => {
    const { container } = renderLightbox(video(), { download_limit: 2, downloads_used: 2, downloads_remaining: 0 });
    expect(screen.getByTestId('lightbox-video-locked')).toHaveTextContent('Download limit reached');
    expect(container.querySelector('video')).toBeNull();
  });

  it('tells a share-link guest the video is for the client', () => {
    const { container } = renderLightbox(video(), { download_limit: null, download_preview_only: true });
    expect(screen.getByTestId('lightbox-video-locked')).toHaveTextContent('available to the client only');
    expect(container.querySelector('video')).toBeNull();
  });

  it('does not preload a video that would take a slot', () => {
    const { container } = renderLightbox(video(), { download_limit: 2, downloads_used: 1, downloads_remaining: 1 });
    expect(container.querySelector('video')?.getAttribute('preload')).toBe('none');
  });

  it('plays a granted video, or any video on an unlimited gallery, as before', () => {
    const granted = renderLightbox(video({ download_granted: true }), { download_limit: 2, downloads_used: 2, downloads_remaining: 0 });
    expect(granted.container.querySelector('video')?.hasAttribute('preload')).toBe(false);
    granted.unmount();

    const unlimited = renderLightbox(video(), { download_limit: null });
    expect(unlimited.container.querySelector('video')).not.toBeNull();
    expect(screen.queryByTestId('lightbox-video-locked')).toBeNull();
  });
});
