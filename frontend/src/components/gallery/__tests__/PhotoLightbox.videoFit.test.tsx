/**
 * Issue 2314: the lightbox player gets a definite height, so the <video>'s
 * h-full object-contain fits a portrait clip into the stage instead of laying
 * it out at its natural aspect from the full width, where the player's
 * overflow-hidden cut it to its top.
 */
import { act, render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Photo } from '../../../types';

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
vi.mock('../../../services', () => ({ galleryService: { savePhotoToDevice: vi.fn() } }));
// The real AuthenticatedImage, without the barrel's i18n-bound neighbours.
vi.mock('../../common', async () => ({
  AuthenticatedImage: (await import('../../common/AuthenticatedImage')).AuthenticatedImage,
}));
vi.mock('react-toastify', () => ({ toast: { error: vi.fn() } }));
vi.mock('../../../utils/galleryAuthStorage', () => ({
  getActiveGallerySlug: () => 'g',
  getGalleryToken: () => 'token',
  inferGallerySlugFromLocation: () => 'g',
  resolveSlugFromRequestUrl: () => 'g',
}));
vi.mock('../../../utils/url', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../utils/url')>()),
  buildResourceUrl: (u: string) => `http://localhost${u}`,
}));

import { PhotoLightbox } from '../PhotoLightbox';
import { DownloadQuotaProvider } from '../../../contexts/DownloadQuotaContext';

vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });

const video = { id: 702, filename: 'clip.mp4', url: '/api/gallery/g/photo/702', thumbnail_url: '/api/gallery/g/thumbnail/702', media_type: 'video', width: 1080, height: 1920 } as Photo;

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({
    ok: true,
    blob: async () => new Blob(['r'], { type: 'image/jpeg' }),
    headers: { get: () => null },
  })));
  URL.createObjectURL = vi.fn(() => 'blob:poster') as unknown as typeof URL.createObjectURL;
  URL.revokeObjectURL = vi.fn() as unknown as typeof URL.revokeObjectURL;
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
});

describe('PhotoLightbox video fit (issue 2314)', () => {
  it('sizes the player to the stage so the clip is contained, not cropped', async () => {
    const { container } = render(
      <QueryClientProvider client={new QueryClient()}>
        <DownloadQuotaProvider slug="g" event={{ download_limit: null } as never}>
          <PhotoLightbox photos={[video]} initialIndex={0} onClose={vi.fn()} slug="g" />
        </DownloadQuotaProvider>
      </QueryClientProvider>,
    );
    await act(async () => {});
    const player = container.querySelector('video');
    expect(player).not.toBeNull();
    expect(player!.className).toContain('h-full');
    expect(player!.className).toContain('object-contain');
    // The wrapper the video's h-full resolves against has a definite height.
    expect((player!.parentElement as HTMLElement).style.height).toBe('100%');
  });
});
