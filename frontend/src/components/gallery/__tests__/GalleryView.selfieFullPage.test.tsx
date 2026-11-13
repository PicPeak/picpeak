/**
 * Selfie search (issue 2355) is offered in every layout. Premium and Story
 * return before the people strip, so their launcher sits in the band above
 * the grid; the dialog opens from there too.
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
vi.mock('../../../services/feedback.service', () => ({
  feedbackService: {
    getGalleryFeedbackSettings: vi.fn().mockResolvedValue({ feedback_enabled: false }),
    getMyFeedback: vi.fn().mockResolvedValue({}),
  },
}));

vi.mock('../GalleryLayout', () => ({
  GalleryLayout: ({ children, headerExtra }: { children?: React.ReactNode; headerExtra?: React.ReactNode }) => <div>{headerExtra}{children}</div>,
}));
vi.mock('../PhotoGridWithLayouts', () => ({
  PhotoGridWithLayouts: ({ photos: shown, openPhotoId }: { photos: Array<{ id: number }>; openPhotoId?: number | null }) => (
    <div data-testid="photo-grid" data-ids={shown.map((p) => p.id).join(',')} data-open={openPhotoId ?? ''} />
  ),
}));
vi.mock('../SelfieSearchDialog', () => ({
  SelfieSearchDialog: ({ open, onResult }: { open: boolean; onResult: (ids: number[]) => void }) => (open ? (
    <div data-testid="selfie-dialog">
      <button type="button" onClick={() => onResult([7])}>match</button>
    </div>
  ) : null),
}));


import { act, fireEvent } from '@testing-library/react';
import { GalleryView } from '../GalleryView';

const event = { id: 1, event_name: 'Hoa Wedding', event_type: 'wedding', event_date: '2026-09-19', expires_at: '2027-09-19T00:00:00Z' };

function show(selfie: boolean) {
  photos = {
    data: {
      event: { ...event, people_enabled: true, selfie_search_enabled: selfie },
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
}

afterEach(cleanup);

describe.each(['gallery-premium', 'gallery-story'])('selfie search on %s', (layout) => {
  it('offers the launcher, which opens the dialog', () => {
    stable.theme.theme = { galleryLayout: layout };
    show(true);
    expect(screen.queryByTestId('selfie-dialog')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'gallery.selfie.open' }));
    expect(screen.getByTestId('selfie-dialog')).toBeInTheDocument();
  });

  it('offers nothing while the search is off', () => {
    stable.theme.theme = { galleryLayout: layout };
    show(false);
    expect(screen.queryByRole('button', { name: 'gallery.selfie.open' })).not.toBeInTheDocument();
  });
});

describe('selfie filter and photo links', () => {
  it('clears the selfie filter when a link opens a photo outside the matches', () => {
    stable.theme.theme = { galleryLayout: 'gallery-premium' };
    show(true);
    fireEvent.click(screen.getByRole('button', { name: 'gallery.selfie.open' }));
    fireEvent.click(screen.getByRole('button', { name: 'match' }));
    expect(screen.getByTestId('photo-grid')).toHaveAttribute('data-ids', '7');

    // Forward to a photo opened before the search.
    act(() => {
      window.history.pushState({}, '', '?photo=8');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    expect(screen.getByTestId('photo-grid')).toHaveAttribute('data-ids', '7,8');
    expect(screen.getByTestId('photo-grid')).toHaveAttribute('data-open', '8');
    window.history.replaceState({}, '', '/');
  });
});
