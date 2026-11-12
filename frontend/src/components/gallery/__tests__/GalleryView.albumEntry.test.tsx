/**
 * The album entry sits at the top of every layout, with the selection actions
 * (issue 2397), not after the whole grid as it did on Premium and Story.
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
vi.mock('../PhotoGridWithLayouts', () => ({ PhotoGridWithLayouts: () => <div data-testid="photo-grid" /> }));
vi.mock('../../../features/album-products/GalleryProductPanel', () => ({
  GalleryProductPanel: ({ className }: { className?: string }) => <div data-testid="album-entry" className={className} />,
}));


import { GalleryView } from '../GalleryView';

const event = { id: 1, event_name: 'Hoa Wedding', event_type: 'wedding', event_date: '2026-09-19', expires_at: '2027-09-19T00:00:00Z' };

function show() {
  photos = {
    data: { event, categories: [], photos: [{ id: 7, filename: 'a.jpg', url: '/a.jpg', thumbnail_url: '/a-t.jpg', type: 'photo', size: 1, uploaded_at: '2026-09-19T10:00:00Z' }] },
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

describe.each(['grid', 'gallery-premium', 'gallery-story'])('album entry on %s', (layout) => {
  it('comes before the photos, once, for a client', () => {
    stable.theme.theme = { galleryLayout: layout };
    stable.auth.isClient = true;
    show();
    const entries = screen.getAllByTestId('album-entry');
    expect(entries).toHaveLength(1);
    expect(entries[0].compareDocumentPosition(screen.getByTestId('photo-grid')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Story's fixed nav covers the top: without the selection band above,
    // the entry makes room for it itself.
    if (layout === 'gallery-story') expect(entries[0]).toHaveClass('pt-20');
    else expect(entries[0]).not.toHaveClass('pt-20');
  });

  it('is not there for a guest', () => {
    stable.theme.theme = { galleryLayout: layout };
    stable.auth.isClient = false;
    show();
    expect(screen.queryByTestId('album-entry')).not.toBeInTheDocument();
  });
});
