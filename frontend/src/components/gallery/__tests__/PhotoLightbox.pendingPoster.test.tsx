/**
 * Issue 2275: a video poster the server is still building (X-Poster-Pending)
 * fills in by itself on the lightbox surfaces too — the neighbour slide and
 * the player's poster — without the lightbox being reopened.
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

const photo = { id: 701, filename: 'IMG_0701.jpg', url: '/api/gallery/g/photo/701', thumbnail_url: '/api/gallery/g/thumbnail/701' } as Photo;
const video = { id: 702, filename: 'clip.mp4', url: '/api/gallery/g/photo/702', thumbnail_url: '/api/gallery/g/thumbnail/702', media_type: 'video' } as Photo;

const headers = (values: Record<string, string>) => ({ get: (name: string) => values[name] ?? null });
const answer = (pending: boolean) => Promise.resolve({
  ok: true,
  // Two bytes for the stand-in, one for the real poster.
  blob: async () => new Blob([pending ? 'pp' : 'r'], { type: 'image/jpeg' }),
  headers: headers(pending ? { 'X-Poster-Pending': '1', 'Retry-After': '10' } : {}),
});

/** The video's poster pends once, then is real; every other image is real. */
function stubFetch() {
  let posterAsks = 0;
  const fetchMock = vi.fn((url: string) => {
    if (url.endsWith('/thumbnail/702')) {
      posterAsks += 1;
      return answer(posterAsks === 1);
    }
    return answer(false);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

// Blob URLs name the bytes they hold, so the test can tell stand-in from real.
let n: number;
beforeEach(() => {
  vi.useFakeTimers();
  n = 0;
  URL.createObjectURL = vi.fn((blob: Blob) => `blob:${++n}-${(blob as Blob & { size: number }).size}`) as unknown as typeof URL.createObjectURL;
  URL.revokeObjectURL = vi.fn() as unknown as typeof URL.revokeObjectURL;
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.useRealTimers();
});

const flush = () => act(async () => { await vi.advanceTimersByTimeAsync(0); });
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

function renderLightbox(items: Photo[]) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <DownloadQuotaProvider slug="g" event={{ download_limit: null } as never}>
        <PhotoLightbox photos={items} initialIndex={0} onClose={vi.fn()} slug="g" />
      </DownloadQuotaProvider>
    </QueryClientProvider>,
  );
}

/** The requests for the video's poster. */
const posterSrcs = (fetchMock: ReturnType<typeof vi.fn>) => fetchMock.mock.calls
  .map(([url]) => String(url))
  .filter((url) => url.endsWith('/thumbnail/702'));

describe('PhotoLightbox pending video poster (issue 2275)', () => {
  it('swaps the neighbour slide from the stand-in to the real poster without a remount', async () => {
    const fetchMock = stubFetch();
    const { container } = renderLightbox([photo, video, { ...photo, id: 703, thumbnail_url: '/api/gallery/g/thumbnail/703' }]);
    await flush();
    expect(posterSrcs(fetchMock)).toHaveLength(1);
    // The only stand-in on screen is the neighbouring video's poster.
    const standIns = Array.from(container.querySelectorAll('img')).filter((img) => img.getAttribute('src')?.endsWith('-2'));
    expect(standIns).toHaveLength(1);
    const neighbour = standIns[0];

    await advance(10_000);
    await flush();
    expect(posterSrcs(fetchMock)).toHaveLength(2);
    // Same element, real bytes.
    expect(neighbour.isConnected).toBe(true);
    expect(neighbour.getAttribute('src')).toMatch(/^blob:\d+-1$/);
  });

  it('swaps the player poster from the stand-in to the real poster', async () => {
    const fetchMock = stubFetch();
    const { container } = renderLightbox([video, photo]);
    await flush();
    const player = container.querySelector('video');
    expect(player).not.toBeNull();
    const first = player!.getAttribute('poster');
    expect(first).toMatch(/^blob:\d+-2$/);

    await advance(10_000);
    await flush();
    expect(posterSrcs(fetchMock).length).toBeGreaterThanOrEqual(2);
    // Same element, new poster.
    expect(container.querySelector('video')).toBe(player);
    expect(player!.getAttribute('poster')).toMatch(/^blob:\d+-1$/);
  });
});
