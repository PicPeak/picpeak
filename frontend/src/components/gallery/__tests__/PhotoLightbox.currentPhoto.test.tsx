/**
 * Link to a single photo (issue 1733): the lightbox reports the photo on
 * screen — once on open and once per step — so the host can mirror it to
 * `?photo=`. Not once per render: the host's inline callback is read through
 * a ref, and rewriting the address bar on every render would trip Safari's
 * replaceState rate limit.
 */
import { render, fireEvent } from '@testing-library/react';
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

const photos = [10, 11, 12].map((id) => ({ id, filename: `${id}.jpg`, url: `/p/${id}`, thumbnail_url: `/t/${id}` } as Photo));

describe('PhotoLightbox onCurrentPhotoChange (issue 1733)', () => {
  it('fires for the opening photo and for every step, not for every render', () => {
    const onCurrentPhotoChange = vi.fn();
    const { rerender } = render(
      <QueryClientProvider client={new QueryClient()}>
        <DownloadQuotaProvider slug="g" event={{} as never}>
          <PhotoLightbox photos={photos} initialIndex={1} onClose={vi.fn()} slug="g" onCurrentPhotoChange={(id) => onCurrentPhotoChange(id)} />
        </DownloadQuotaProvider>
      </QueryClientProvider>,
    );
    expect(onCurrentPhotoChange.mock.calls).toEqual([[11]]);

    // A re-render with a fresh inline callback is not a step.
    rerender(
      <QueryClientProvider client={new QueryClient()}>
        <DownloadQuotaProvider slug="g" event={{} as never}>
          <PhotoLightbox photos={photos} initialIndex={1} onClose={vi.fn()} slug="g" onCurrentPhotoChange={(id) => onCurrentPhotoChange(id)} />
        </DownloadQuotaProvider>
      </QueryClientProvider>,
    );
    expect(onCurrentPhotoChange).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(document, { key: 'ArrowRight' });
    expect(onCurrentPhotoChange).toHaveBeenLastCalledWith(12);
    fireEvent.keyDown(document, { key: 'ArrowLeft' });
    fireEvent.keyDown(document, { key: 'ArrowLeft' });
    expect(onCurrentPhotoChange).toHaveBeenLastCalledWith(10);
    expect(onCurrentPhotoChange).toHaveBeenCalledTimes(4);
  });
});
