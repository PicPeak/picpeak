/**
 * "Cancel selection" ends selection mode AND drops the selection. Toggling the
 * mode alone left every tick in place: Select all, then Cancel selection, and
 * the photos stayed selected, so "Download selected" still offered them and
 * the next "Select photos" started with the old ticks.
 */
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

type SidebarProps = {
  onToggleSelectionMode: () => void;
  isSelectionMode: boolean;
  selectedCount: number;
};
type GridProps = {
  onToggleSelectionMode: () => void;
  onSelectionChange: (ids: Set<number>) => void;
  isSelectionMode: boolean;
  selectedPhotos: Set<number>;
};

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

import { GalleryView } from '../GalleryView';

const event = {
  id: 1,
  event_name: 'Hoa Wedding',
  event_type: 'wedding',
  event_date: '2026-09-19',
  expires_at: '2027-09-19T00:00:00Z',
};

const photo = (id: number, filename: string) => ({
  id, filename, url: `/${filename}`, thumbnail_url: `/t-${filename}`, type: 'photo', size: 1,
  uploaded_at: '2026-09-19T10:00:00Z',
});

function show() {
  stable.photos = {
    data: {
      event: { ...event, allow_downloads: true },
      categories: [],
      photos: [photo(7, 'ceremony.jpg'), photo(8, 'dinner.jpg'), photo(9, 'dance.jpg')],
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

function selectAll() {
  act(() => captured.sidebar.onToggleSelectionMode());
  act(() => captured.grid.onSelectionChange(new Set([7, 8, 9])));
  expect(captured.sidebar.isSelectionMode).toBe(true);
  expect(captured.sidebar.selectedCount).toBe(3);
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('GalleryView "Cancel selection"', () => {
  it("the sidebar's Cancel selection clears what was selected", () => {
    show();
    selectAll();
    act(() => captured.sidebar.onToggleSelectionMode());
    expect(captured.sidebar.isSelectionMode).toBe(false);
    expect(captured.sidebar.selectedCount).toBe(0);
    expect(captured.grid.selectedPhotos.size).toBe(0);
  });

  it("the grid's Cancel selection clears what was selected", () => {
    show();
    selectAll();
    act(() => captured.grid.onToggleSelectionMode());
    expect(captured.grid.isSelectionMode).toBe(false);
    expect(captured.grid.selectedPhotos.size).toBe(0);
  });

  it('selecting again starts from nothing', () => {
    show();
    selectAll();
    act(() => captured.sidebar.onToggleSelectionMode());
    act(() => captured.sidebar.onToggleSelectionMode());
    expect(captured.sidebar.isSelectionMode).toBe(true);
    expect(captured.sidebar.selectedCount).toBe(0);
  });

  it('turning selection mode on keeps a selection made before it', () => {
    show();
    act(() => captured.grid.onSelectionChange(new Set([8])));
    act(() => captured.sidebar.onToggleSelectionMode());
    expect(captured.sidebar.isSelectionMode).toBe(true);
    expect(captured.sidebar.selectedCount).toBe(1);
  });
});
