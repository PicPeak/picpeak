/**
 * Issue 2263 (iPhone Safari):
 *  - centred on the screen, the prev/next arrows covered a video's own control
 *    bar (the Next arrow sat on the fullscreen button). For a video they are
 *    lifted above the stage's midpoint instead; photos keep them centred.
 *  - the lightbox tells the save path the item is a video, so iOS can
 *    download it directly instead of buffering it for the share sheet.
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

const photo = { id: 601, filename: 'IMG_0601.jpg', url: '/api/gallery/g/photo/601', thumbnail_url: '/t/601' } as Photo;
const video = { id: 602, filename: 'clip.mp4', url: '/api/gallery/g/photo/602', thumbnail_url: '/t/602', media_type: 'video' } as Photo;

function renderLightbox(items: Photo[]) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <DownloadQuotaProvider slug="g" event={{ download_limit: null } as never}>
        <PhotoLightbox photos={items} initialIndex={0} onClose={vi.fn()} slug="g" />
      </DownloadQuotaProvider>
    </QueryClientProvider>,
  );
}

const arrows = () => [
  screen.getByRole('button', { name: 'Previous photo' }),
  screen.getByRole('button', { name: 'Next photo' }),
];

describe('PhotoLightbox nav arrows on a video (issue 2263)', () => {
  it('lifts both arrows above the stage midpoint, clear of the video control bar', () => {
    renderLightbox([video, photo]);
    for (const arrow of arrows()) {
      expect(arrow.className).not.toContain('top-1/2');
      expect(arrow.className).not.toContain('-translate-y-1/2');
      // Inline style: jsdom reorders a max()/env() value when it serialises
      // it, so only its parts are checked.
      const style = arrow.getAttribute('style') ?? '';
      expect(style).toContain('(100% - 0px) - 132px)');
      expect(style).toContain('env(safe-area-inset-top)');
    }
  });

  it('keeps the arrows centred for a photo', () => {
    renderLightbox([photo, video]);
    for (const arrow of arrows()) {
      expect(arrow.className).toContain('top-1/2');
      expect(arrow.className).toContain('-translate-y-1/2');
      expect(arrow.getAttribute('style') ?? '').not.toContain('132px');
    }
  });
});

describe('PhotoLightbox download of a video (issue 2263)', () => {
  it('hands isVideo to the save path for a video', async () => {
    svc.savePhotoToDevice.mockReset().mockResolvedValue(undefined);
    renderLightbox([video]);
    fireEvent.click(screen.getByRole('button', { name: /Download/ }));
    await waitFor(() => expect(svc.savePhotoToDevice).toHaveBeenCalledTimes(1));
    expect(svc.savePhotoToDevice.mock.calls[0][5]).toBe(true);
  });

  it('hands isVideo false for a photo', async () => {
    svc.savePhotoToDevice.mockReset().mockResolvedValue(undefined);
    renderLightbox([photo]);
    fireEvent.click(screen.getByRole('button', { name: /Download photo/ }));
    await waitFor(() => expect(svc.savePhotoToDevice).toHaveBeenCalledTimes(1));
    expect(svc.savePhotoToDevice.mock.calls[0][5]).toBe(false);
  });
});
