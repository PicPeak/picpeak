/**
 * The public gallery in a browser whose Web Storage throws (private window,
 * blocked site data, Safari with storage disabled): no crash, and the guest
 * id stays the same for the whole page view.
 */
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

type PhotosResult = { data: unknown; isLoading: boolean; error: unknown; refetch: () => void };
let photos: PhotosResult;
const guestIds: string[] = [];

// Hooks hand back the same objects on every render, as the real ones do;
// fresh ones each time would re-run the view's effects without end.
const stable = vi.hoisted(() => ({
  auth: { logout: vi.fn(), endSession: vi.fn(), isClient: false, viaCustomer: false },
  theme: { setTheme: () => {}, theme: {} },
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
  useGalleryPhotos: (_slug: string, _filter: string, guestId: string) => { guestIds.push(guestId); return photos; },
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
  galleryService: { getPeople: vi.fn().mockResolvedValue({ people: [] }), startDownloadJob: vi.fn().mockResolvedValue({ token: 'job', status: 'pending' }) },
}));
vi.mock('../../../services/feedback.service', () => ({
  feedbackService: {
    getGalleryFeedbackSettings: vi.fn().mockResolvedValue({ feedback_enabled: false }),
    getMyFeedback: vi.fn().mockResolvedValue({}),
  },
}));

vi.mock('../GalleryLayout', () => ({
  GalleryLayout: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('../PhotoGridWithLayouts', () => ({
  PhotoGridWithLayouts: () => <div data-testid="photo-grid" />,
}));

import { GalleryView } from '../GalleryView';

const event = {
  id: 1,
  event_name: 'Hoa Wedding',
  event_type: 'wedding',
  event_date: '2026-09-19',
  expires_at: '2027-09-19T00:00:00Z',
};

const loaded = {
  event: { ...event },
  categories: [],
  photos: [{ id: 7, filename: 'a.jpg', url: '/a.jpg', thumbnail_url: '/a-t.jpg', type: 'photo', size: 1, uploaded_at: '2026-09-19T10:00:00Z' }],
};

function show() {
  photos = { data: loaded, isLoading: false, error: null, refetch: vi.fn() };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <GalleryView slug="wedding" event={event} />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  guestIds.length = 0;
});

// Private windows, blocked site data and Safari with storage disabled throw on
// every storage call. The gallery must still render for that page view.
describe('GalleryView without usable storage', () => {
  it('renders and keeps one guest id for the visit when getItem/setItem throw', () => {
    const denied = () => { throw new DOMException('The operation is insecure.', 'SecurityError'); };
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(denied);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(denied);

    show();
    expect(screen.getByTestId('photo-grid')).toBeInTheDocument();
    const first = guestIds.filter(Boolean);
    expect(first.length).toBeGreaterThan(0);
    expect(new Set(first).size).toBe(1);

    // A remount within the same page view (route change back to the gallery)
    // reuses the same id instead of minting a new guest.
    cleanup();
    show();
    expect(screen.getByTestId('photo-grid')).toBeInTheDocument();
    expect(new Set(guestIds.filter(Boolean))).toEqual(new Set(first));
  });
});
