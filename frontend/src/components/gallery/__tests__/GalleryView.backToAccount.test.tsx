/**
 * The way back to the customer portal is offered for a portal session
 * (`viaCustomer`, set by the server on tokens the portal mints) only: never
 * to a share-link guest or a PIN client, and not in an admin preview.
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
  theme: { setTheme: () => {}, theme: { galleryLayout: 'grid' } as { galleryLayout: string } },
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
vi.mock('../../../features/album-products/GalleryProductPanel', () => ({ GalleryProductPanel: () => null }));
// A portal session switches the print shop on, which would go to the network.
vi.mock('../../../features/print-sales/GalleryPrintShop', () => ({
  PrintSalesProvider: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  PrintShopEntry: () => null,
}));

// Both report what they were handed.
vi.mock('../GalleryLayout', () => ({
  GalleryLayout: ({ children, showBackToAccount }: { children?: React.ReactNode; showBackToAccount?: boolean }) => (
    <div data-testid="layout" data-back={String(!!showBackToAccount)}>{children}</div>
  ),
}));
vi.mock('../PhotoGridWithLayouts', () => ({
  PhotoGridWithLayouts: ({ showBackToAccount }: { showBackToAccount?: boolean }) => (
    <div data-testid="photo-grid" data-back={String(!!showBackToAccount)} />
  ),
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

// The standard layouts take it in the GalleryLayout header, the full-page
// ones in their own nav.
const backOffered = (layout: string) =>
  screen.getByTestId(layout === 'grid' ? 'layout' : 'photo-grid').dataset.back;

afterEach(() => {
  cleanup();
  stable.auth.viaCustomer = false;
  stable.auth.isClient = false;
});

describe.each(['grid', 'gallery-premium', 'gallery-story'])('back to the account on %s', (layout) => {
  it('is offered to a portal session', () => {
    stable.theme.theme = { galleryLayout: layout };
    stable.auth.viaCustomer = true;
    show();
    expect(backOffered(layout)).toBe('true');
  });

  it('is not offered to a share-link guest', () => {
    stable.theme.theme = { galleryLayout: layout };
    show();
    expect(backOffered(layout)).toBe('false');
  });

  it('is not offered to a PIN client', () => {
    stable.theme.theme = { galleryLayout: layout };
    stable.auth.isClient = true;
    show();
    expect(backOffered(layout)).toBe('false');
  });

  it('is not offered in an admin preview', () => {
    const previous = window.location.href;
    window.history.replaceState(null, '', '?admin_preview=1');
    try {
      stable.theme.theme = { galleryLayout: layout };
      stable.auth.viaCustomer = true;
      show();
      expect(backOffered(layout)).toBe('false');
    } finally { window.history.replaceState(null, '', previous); }
  });
});
