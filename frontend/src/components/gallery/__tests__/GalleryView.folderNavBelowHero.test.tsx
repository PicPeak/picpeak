/**
 * Folder navigation below the hero (issue 2504). The standard layouts draw
 * the hero header inside PhotoGridWithLayouts, so the folder tiles go there
 * as `afterHero`: rendered after the hero and the welcome message, not ahead
 * of the whole grid component where they sat above the hero.
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
  theme: { setTheme: () => {}, theme: { galleryLayout: 'grid', headerStyle: 'hero' } as { galleryLayout: string; headerStyle?: string } },
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
  PhotoGridWithLayouts: ({ afterHero }: { afterHero?: React.ReactNode }) => (
    <div data-testid="photo-grid">
      <div data-testid="hero" />
      <div data-testid="after-hero">{afterHero}</div>
    </div>
  ),
}));

import { within } from '@testing-library/react';
import { GalleryView } from '../GalleryView';

const event = { id: 1, event_name: 'Hoa Wedding', event_type: 'wedding', event_date: '2026-09-19', expires_at: '2027-09-19T00:00:00Z' };

function show(withLoosePhoto: boolean) {
  const photo = (id: number, folder: number | null) => ({
    id, filename: `${id}.jpg`, url: `/${id}.jpg`, thumbnail_url: `/${id}-t.jpg`, type: 'photo', size: 1,
    uploaded_at: '2026-09-19T10:00:00Z', category_id: null, folder_id: folder,
  });
  photos = {
    data: {
      event,
      categories: [{ id: 3, name: 'Ceremony', slug: 'ceremony', is_folder: true, parent_id: null }],
      photos: [photo(7, 3), photo(8, 3), ...(withLoosePhoto ? [photo(9, null)] : [])],
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

describe.each([true, false])('folder navigation with loose photos: %s', (loose) => {
  it('is handed to the grid below the hero, not rendered above it', () => {
    show(loose);
    const tile = screen.getByRole('button', { name: 'gallery.openFolder' });
    expect(within(screen.getByTestId('after-hero')).getByRole('button', { name: 'gallery.openFolder' })).toBe(tile);
    // Nothing of the folder navigation precedes the grid component.
    expect(screen.getAllByRole('button', { name: 'gallery.openFolder' })).toHaveLength(1);
    expect(screen.getByTestId('hero').compareDocumentPosition(tile) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
