/**
 * The size picker opened from the sidebar's "Download selected". A download it
 * hands over ends the selection, as the sidebar's direct download does; a
 * picker closed without one (cancel, refusal, failed build) keeps it, and a
 * picker opened for a people filter leaves an unrelated selection alone.
 */
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

type SidebarProps = { onDownloadSelected: () => Promise<void>; selectedCount: number };
type GridProps = { onSelectionChange: (ids: Set<number>) => void };

const captured = vi.hoisted(() => ({
  sidebar: null as unknown as SidebarProps,
  grid: null as unknown as GridProps,
}));

// Hooks hand back the same objects on every render, as the real ones do;
// fresh ones each time would re-run the view's effects without end.
const stable = vi.hoisted(() => ({
  auth: { logout: () => {}, endSession: () => {}, isClient: false, viaCustomer: false },
  theme: { setTheme: () => {}, theme: { controlsStyle: 'sidebar' } },
  download: { mutate: () => {}, isPending: false },
  settings: { data: {} },
  watermark: { watermarkEnabled: false },
  t: (key: string) => key,
  photos: null as unknown,
}));

vi.mock('../../../contexts', () => ({
  useGalleryAuth: () => stable.auth,
  useTheme: () => stable.theme,
}));
vi.mock('../../../hooks/useGallery', () => ({
  useGalleryPhotos: () => stable.photos,
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
vi.mock('react-toastify', () => ({ toast: { info: vi.fn(), error: vi.fn(), success: vi.fn() } }));
vi.mock('../../../services/analytics.service', () => ({
  analyticsService: { track: vi.fn(), trackGalleryEvent: vi.fn(), trackSearch: vi.fn(), trackExpirationWarning: vi.fn() },
}));
vi.mock('../../../services/gallery.service', () => ({
  splitIntoArchives: (ids: number[]) => [ids],
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
vi.mock('../GallerySidebar', () => ({
  GallerySidebar: (props: SidebarProps) => {
    captured.sidebar = props;
    return null;
  },
}));
vi.mock('../PhotoGridWithLayouts', () => ({
  PhotoGridWithLayouts: (props: GridProps) => {
    captured.grid = props;
    return null;
  },
}));
vi.mock('../DownloadResolutionModal', () => ({
  DownloadResolutionModal: ({ onClose, onDownloaded }: { onClose: () => void; onDownloaded?: () => void }) => (
    <>
      <button data-testid="picker-close" onClick={onClose} />
      <button data-testid="picker-downloaded" onClick={() => { onDownloaded?.(); onClose(); }} />
    </>
  ),
}));

import { GalleryView } from '../GalleryView';

const event = {
  id: 1,
  event_name: 'Hoa Wedding',
  event_type: 'wedding',
  event_date: '2026-09-19',
  expires_at: '2099-09-19T00:00:00Z',
};

const photo = (id: number) => ({
  id, filename: `${id}.jpg`, url: `/${id}.jpg`, thumbnail_url: `/t-${id}.jpg`, type: 'photo', size: 1,
  uploaded_at: '2026-09-19T10:00:00Z',
});

function show() {
  stable.photos = {
    data: {
      event: {
        ...event,
        allow_downloads: true,
        download_resolution: { picker_enabled: true, standard: 'original', choices: [{ id: 'original' }, { id: '1920x1080' }] },
      },
      categories: [],
      photos: [photo(7), photo(8), photo(9)],
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

async function openPickerForSelection() {
  act(() => captured.grid.onSelectionChange(new Set([7, 8])));
  await waitFor(() => expect(captured.sidebar.selectedCount).toBe(2));
  await act(() => captured.sidebar.onDownloadSelected());
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('GalleryView — size picker for the sidebar selection', () => {
  it('ends the selection once the picker handed the download over', async () => {
    show();
    await openPickerForSelection();
    fireEvent.click(screen.getByTestId('picker-downloaded'));
    await waitFor(() => expect(captured.sidebar.selectedCount).toBe(0));
  });

  it('keeps the selection when the picker closes without a download', async () => {
    show();
    await openPickerForSelection();
    fireEvent.click(screen.getByTestId('picker-close'));
    expect(screen.queryByTestId('picker-close')).toBeNull();
    expect(captured.sidebar.selectedCount).toBe(2);
  });
});
