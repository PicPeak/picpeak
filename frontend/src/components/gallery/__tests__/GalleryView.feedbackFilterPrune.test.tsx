/**
 * Feedback filters follow the gallery's settings (issue 2505). When an admin
 * switches a feedback type off while a guest has its filter on, the next
 * settings fetch drops the filter as well as its chip: otherwise the photos
 * stay narrowed with no control left to clear it.
 */
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

type PhotosResult = { data: unknown; isLoading: boolean; error: unknown; refetch: () => void };
let photos: PhotosResult;

// Hooks hand back the same objects on every render, as the real ones do;
// fresh ones each time would re-run the view's effects without end.
const stable = vi.hoisted(() => ({
  auth: { logout: () => {}, endSession: () => {}, isClient: false, viaCustomer: false, viaClientPin: false,
    enterClientMode: vi.fn(), leaveClientMode: vi.fn() },
  theme: { setTheme: () => {}, theme: { galleryLayout: 'gallery-premium' } as { galleryLayout: string } },
  download: { mutate: () => {}, isPending: false },
  settings: { data: {} },
  watermark: { watermarkEnabled: false },
  t: (key: string) => key,
}));

vi.mock('../../../contexts', () => ({
  useGalleryAuth: () => stable.auth,
  useTheme: () => stable.theme,
}));

vi.mock('../../../hooks/useGallery', () => ({
  useGalleryPhotos: () => photos,
  useDownloadAllPhotos: () => stable.download,
}));

vi.mock('../../../hooks/usePublicSettings', () => ({ usePublicSettings: () => stable.settings }));
vi.mock('../../../hooks/useWatermarkSettings', () => ({ useWatermarkSettings: () => stable.watermark }));
vi.mock('../../../hooks/useGalleryCustomCss', () => ({ useGalleryCustomCss: () => undefined }));
vi.mock('../../../hooks/useDevToolsProtection', () => ({ useDevToolsProtection: () => undefined }));

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({ t: stable.t, i18n: { language: 'en' } }),
}));

vi.mock('../../../services/analytics.service', () => ({
  analyticsService: { track: vi.fn(), trackGalleryEvent: vi.fn(), trackSearch: vi.fn(), trackExpirationWarning: vi.fn() },
}));
vi.mock('../../../services/gallery.service', () => ({
  galleryService: { getPeople: vi.fn().mockResolvedValue({ people: [] }) },
}));
const settings = vi.hoisted(() => ({ current: { feedback_enabled: true, allow_likes: true } as Record<string, unknown> }));
vi.mock('../../../services/feedback.service', () => ({
  feedbackService: {
    getGalleryFeedbackSettings: vi.fn(async () => settings.current),
    getMyFeedback: vi.fn().mockResolvedValue({}),
  },
}));

vi.mock('../GalleryLayout', () => ({
  GalleryLayout: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('../PhotoGridWithLayouts', () => ({
  PhotoGridWithLayouts: ({ likedOnly, onToggleLikedOnly }: { likedOnly?: boolean; onToggleLikedOnly?: () => void }) => (
    <button type="button" data-testid="liked" aria-pressed={!!likedOnly} onClick={onToggleLikedOnly}>liked</button>
  ),
}));

import { act, fireEvent, waitFor } from '@testing-library/react';
import { GalleryView } from '../GalleryView';

const event = { id: 1, event_name: 'Hoa Wedding', event_type: 'wedding', event_date: '2026-09-19', expires_at: '2027-09-19T00:00:00Z' };

afterEach(cleanup);

describe('feedback filters after a settings change', () => {
  it('drops an active filter whose feedback type was switched off', async () => {
    settings.current = { feedback_enabled: true, allow_likes: true };
    photos = {
      data: {
        event,
        categories: [],
        photos: [7, 8].map((id) => ({ id, filename: `${id}.jpg`, url: `/${id}.jpg`, thumbnail_url: `/${id}-t.jpg`, type: 'photo', size: 1, uploaded_at: '2026-09-19T10:00:00Z' })),
      },
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    };
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <GalleryView slug="wedding" event={event} />
      </QueryClientProvider>,
    );
    await act(async () => {});
    fireEvent.click(screen.getByTestId('liked'));
    await waitFor(() => expect(screen.getByTestId('liked')).toHaveAttribute('aria-pressed', 'true'));

    settings.current = { feedback_enabled: true, allow_likes: false };
    await act(async () => { await client.invalidateQueries(); });
    await waitFor(() => expect(screen.getByTestId('liked')).toHaveAttribute('aria-pressed', 'false'));
  });
});
