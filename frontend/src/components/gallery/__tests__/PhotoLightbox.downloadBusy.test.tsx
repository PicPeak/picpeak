/**
 * Issue 2043: the lightbox's download button spins while the photo is being
 * prepared (a blob fetch on iOS and on limited galleries, the share sheet on
 * iOS), and a repeated tap starts no second download.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import type { Photo } from '../../../types';

const svc = vi.hoisted(() => ({ savePhotoToDevice: vi.fn() }));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string, d?: unknown) => (typeof d === 'string' ? d : k) }) }));
vi.mock('../../../hooks/useDevToolsProtection', () => ({ useDevToolsProtection: () => undefined }));
vi.mock('../../../hooks/useFeedbackLimitModal', () => ({ useFeedbackLimitModal: () => ({ modal: null, handleError: () => false }) }));
vi.mock('../../../contexts/GuestIdentityContext', () => ({ useGuestIdentityOptional: () => null }));
vi.mock('../../../services/feedback.service', () => ({
  feedbackService: {
    getGalleryFeedbackSettings: vi.fn().mockResolvedValue({ feedback_enabled: false }),
    getPhotoFeedback: vi.fn().mockResolvedValue(null),
  },
}));
vi.mock('../../../services/gallery.service', () => ({ galleryService: { trackPhotoView: vi.fn() } }));
// The real download hook reads the service through the barrel.
vi.mock('../../../services', () => ({ galleryService: { savePhotoToDevice: svc.savePhotoToDevice } }));
vi.mock('../../common', () => ({
  AuthenticatedImage: ({ alt }: { alt: string }) => <img alt={alt} />,
}));
vi.mock('react-toastify', () => ({ toast: { error: vi.fn() } }));

import { PhotoLightbox } from '../PhotoLightbox';
import { DownloadQuotaProvider } from '../../../contexts/DownloadQuotaContext';

vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });

const photo = { id: 501, filename: 'IMG_0501.jpg', url: '/api/gallery/g/photo/501', thumbnail_url: '/t/501' } as Photo;

const downloadButton = () => screen.getByRole('button', { name: /Download photo|Preparing your download/ });

describe('PhotoLightbox download button while the download is prepared (issue 2043)', () => {
  it('spins and ignores repeated taps until the photo is handed over', async () => {
    let finish!: () => void;
    svc.savePhotoToDevice.mockReturnValue(new Promise<void>((resolve) => { finish = resolve; }));
    render(
      <QueryClientProvider client={new QueryClient()}>
        <DownloadQuotaProvider slug="g" event={{ download_limit: null } as never}>
          <PhotoLightbox photos={[photo]} initialIndex={0} onClose={vi.fn()} slug="g" />
        </DownloadQuotaProvider>
      </QueryClientProvider>,
    );

    expect(downloadButton()).not.toHaveAttribute('aria-busy');
    fireEvent.click(downloadButton());
    await waitFor(() => expect(downloadButton()).toHaveAttribute('aria-busy', 'true'));
    expect(downloadButton()).toHaveAccessibleName('Preparing your download…');
    expect(downloadButton().querySelector('.animate-spin')).not.toBeNull();

    fireEvent.click(downloadButton());
    fireEvent.click(downloadButton());
    await new Promise((r) => setTimeout(r, 0));
    expect(svc.savePhotoToDevice).toHaveBeenCalledTimes(1);

    finish();
    await waitFor(() => expect(downloadButton()).not.toHaveAttribute('aria-busy'));
    expect(downloadButton()).toHaveAccessibleName('Download photo');
  });
});
