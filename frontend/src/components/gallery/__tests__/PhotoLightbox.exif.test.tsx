/**
 * Camera details in the lightbox (issue 1733, D1): one row under the counter,
 * each part left out when missing, no row at all when the photo carries none
 * or the gallery does not show them (the key is absent then).
 */
import { render, fireEvent, screen } from '@testing-library/react';
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

const base = (id: number) => ({ id, filename: `${id}.jpg`, url: `/p/${id}`, thumbnail_url: `/t/${id}` });
const photos = [
  { ...base(1), exif: { make: 'Canon', model: 'Canon EOS R5', lens: 'RF50mm F1.2 L USM', focal_length: 50, aperture: 1.2, exposure_time: 0.004, iso: 400 } },
  { ...base(2), exif: { model: 'X-T5', exposure_time: 2 } },
  { ...base(3), exif: null },
  { ...base(4) },
] as Photo[];

describe('PhotoLightbox camera details (issue 1733, D1)', () => {
  it('shows the row with the parts it has, and no row without any', () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <DownloadQuotaProvider slug="g" event={{} as never}>
          <PhotoLightbox photos={photos} initialIndex={0} onClose={vi.fn()} slug="g" />
        </DownloadQuotaProvider>
      </QueryClientProvider>,
    );
    expect(screen.getByTestId('lightbox-exif').textContent)
      .toBe('Canon EOS R5 · RF50mm F1.2 L USM · 50 mm · f/1.2 · 1/250 s · ISO 400');

    fireEvent.keyDown(document, { key: 'ArrowRight' });
    expect(screen.getByTestId('lightbox-exif').textContent).toBe('X-T5 · 2 s');

    fireEvent.keyDown(document, { key: 'ArrowRight' });
    expect(screen.queryByTestId('lightbox-exif')).toBeNull();

    fireEvent.keyDown(document, { key: 'ArrowRight' });
    expect(screen.queryByTestId('lightbox-exif')).toBeNull();
  });
});
