/**
 * Guest upload on the full-page layouts (Gallery Premium, Story). They skip
 * the GalleryLayout header, the only place the other layouts render the
 * upload button, so the view hands them an `onUploadClick` instead — under
 * the same gate as that button — and it opens the same upload dialog.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

type PhotosResult = { data: unknown; isLoading: boolean; error: unknown; refetch: () => void };
let photos: PhotosResult;

// Hooks hand back the same objects on every render, as the real ones do;
// fresh ones each time would re-run the view's effects without end.
const stable = vi.hoisted(() => ({
  auth: { logout: () => {}, endSession: () => {}, isClient: false, viaCustomer: false },
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
  GalleryLayout: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}));
// Renders the callback as a button, the way the layouts' nav does.
vi.mock('../PhotoGridWithLayouts', () => ({
  PhotoGridWithLayouts: ({ onUploadClick }: { onUploadClick?: () => void }) => (
    <div data-testid="photo-grid">
      {onUploadClick && <button type="button" onClick={onUploadClick}>layout-upload</button>}
    </div>
  ),
}));
vi.mock('../UserPhotoUpload', () => ({
  UserPhotoUpload: () => <div data-testid="upload-dialog" />,
}));

import { GalleryView } from '../GalleryView';

const event = {
  id: 1,
  event_name: 'Hoa Wedding',
  event_type: 'wedding',
  event_date: '2026-09-19',
  expires_at: '2027-09-19T00:00:00Z',
};

function show(allowUploads: boolean, initialAllowUploads?: boolean) {
  photos = {
    data: {
      event: { ...event, allow_user_uploads: allowUploads },
      categories: [],
      photos: [{ id: 7, filename: 'a.jpg', url: '/a.jpg', thumbnail_url: '/a-t.jpg', type: 'photo', size: 1, uploaded_at: '2026-09-19T10:00:00Z' }],
    },
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <GalleryView slug="wedding" event={{ ...event, allow_user_uploads: initialAllowUploads }} />
    </QueryClientProvider>,
  );
}

afterEach(cleanup);

describe.each(['gallery-premium', 'gallery-story'])('GalleryView upload on %s', (layout) => {
  beforeEach(() => {
    stable.theme.theme = { galleryLayout: layout };
  });

  it('hands the layout an upload callback that opens the upload dialog', () => {
    show(true);
    expect(screen.queryByTestId('upload-dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'layout-upload' }));
    expect(screen.getByTestId('upload-dialog')).toBeInTheDocument();
  });

  it('passes no callback when uploads are off', () => {
    show(false);
    expect(screen.getByTestId('photo-grid')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'layout-upload' })).toBeNull();
  });

  // The `event` prop is the /info snapshot taken when the page loaded; the
  // /photos payload is refetched. An admin turning uploads off must win.
  it('follows the fresh /photos value over a stale initial event', () => {
    show(false, true);
    expect(screen.getByTestId('photo-grid')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'layout-upload' })).toBeNull();
  });
});
