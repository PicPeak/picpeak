/**
 * Client access on the full-page layouts (Gallery Premium, Story; issue
 * 1992). They render the eye toggle themselves, so the view has to hand them
 * `isClient` and `onToggleVisibility` exactly as it does the standard layouts.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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
// Reports what the layout was handed.
vi.mock('../PhotoGridWithLayouts', () => ({
  PhotoGridWithLayouts: ({ isClient, onToggleVisibility, onManageGallery }: { isClient?: boolean; onToggleVisibility?: unknown; onManageGallery?: () => void }) => (
    <div data-testid="photo-grid" data-client={String(!!isClient)} data-toggle={String(typeof onToggleVisibility === 'function')}>
      {onManageGallery && <button onClick={onManageGallery}>{isClient ? 'clientAccess.returnToGallery' : 'clientAccess.manageGallery'}</button>}
    </div>
  ),
}));

import { GalleryView } from '../GalleryView';

const event = {
  id: 1,
  event_name: 'Hoa Wedding',
  event_type: 'wedding',
  event_date: '2026-09-19',
  expires_at: '2027-09-19T00:00:00Z',
};

function show(canManage = false) {
  photos = {
    data: {
      event: { ...event, client_pin_entry_available: canManage },
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
      <GalleryView slug="wedding" event={event} />
    </QueryClientProvider>,
  );
}

afterEach(cleanup);

it('keeps session-management actions out of an admin preview', () => {
  const previous = window.location.href;
  window.history.replaceState(null, '', '?admin_preview=1');
  try {
    stable.theme.theme = { galleryLayout: 'grid' };
    stable.auth.isClient = true;
    show(true);
    expect(screen.queryByRole('button', { name: 'clientAccess.manageGallery' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'clientAccess.returnToGallery' })).not.toBeInTheDocument();
  } finally { window.history.replaceState(null, '', previous); }
});

describe.each(['grid', 'gallery-premium', 'gallery-story'])('gallery PIN entry on %s', (layout) => {
  beforeEach(() => {
    stable.theme.theme = { galleryLayout: layout };
    stable.auth.isClient = false;
    stable.auth.viaClientPin = false;
    stable.auth.enterClientMode.mockReset().mockResolvedValue(undefined);
    stable.auth.leaveClientMode.mockReset().mockResolvedValue(undefined);
  });

  it('offers no guest entry without the server capability', () => {
    show();
    expect(screen.queryByRole('button', { name: 'clientAccess.manageGallery' })).not.toBeInTheDocument();
  });

  it('opens the shared PIN dialog and uses the current gallery session', async () => {
    show(true);
    fireEvent.click(screen.getByRole('button', { name: 'clientAccess.manageGallery' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('clientAccess.pinLabel'), 'Client-Pin-2026!');
    fireEvent.click(screen.getByRole('button', { name: 'clientAccess.loginButton' }));
    await waitFor(() => expect(stable.auth.enterClientMode).toHaveBeenCalledExactlyOnceWith('wedding', 'Client-Pin-2026!'));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('offers a real guest downgrade to a PIN-entry client', async () => {
    stable.auth.isClient = true;
    stable.auth.viaClientPin = true;
    show();
    fireEvent.click(screen.getByRole('button', { name: 'clientAccess.returnToGallery' }));
    await waitFor(() => expect(stable.auth.leaveClientMode).toHaveBeenCalledExactlyOnceWith('wedding'));
  });

  it('keeps a private-link client in client view without a misleading return action', () => {
    stable.auth.isClient = true;
    show(true);
    expect(screen.queryByRole('button', { name: 'clientAccess.returnToGallery' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'clientAccess.manageGallery' })).not.toBeInTheDocument();
  });
});

describe.each(['gallery-premium', 'gallery-story'])('GalleryView client access on %s', (layout) => {
  beforeEach(() => {
    stable.theme.theme = { galleryLayout: layout };
  });

  it('hands a client the visibility toggle', () => {
    stable.auth.isClient = true;
    show();
    const grid = screen.getByTestId('photo-grid');
    expect(grid.dataset.client).toBe('true');
    expect(grid.dataset.toggle).toBe('true');
  });

  it('hands a guest no toggle', () => {
    stable.auth.isClient = false;
    show();
    const grid = screen.getByTestId('photo-grid');
    expect(grid.dataset.client).toBe('false');
    expect(grid.dataset.toggle).toBe('false');
  });
});
