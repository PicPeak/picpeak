/**
 * The first-visit walkthrough (issue 2551) in the gallery: shown once per
 * gallery and scope, reopened from the help icon, never while the gallery
 * has it off or in an admin preview.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

type SidebarProps = {
  onDownloadSelected: () => Promise<void>;
  copyFilenamesCount: number;
};
type GridProps = { onSelectionChange: (ids: Set<number>) => void; onToggleSelectionMode: () => void; showOriginalFilename?: boolean };

const captured = vi.hoisted(() => ({
  sidebar: null as unknown as SidebarProps,
  grid: null as unknown as GridProps,
}));

// Hooks hand back the same objects on every render, as the real ones do;
// fresh ones each time would re-run the view's effects without end.
const stable = vi.hoisted(() => ({
  auth: { logout: () => {}, isClient: false, viaCustomer: false } as Record<string, unknown>,
  theme: { setTheme: () => {}, theme: { controlsStyle: 'sidebar' } },
  download: { mutate: () => {}, isPending: false },
  settings: { data: {} },
  watermark: { watermarkEnabled: false },
  t: (key: string) => key,
  photos: null as unknown,
}));

const service = vi.hoisted(() => ({
  downloadPhoto: vi.fn().mockResolvedValue(undefined),
  downloadSelectedPhotos: vi.fn().mockResolvedValue(undefined),
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
  galleryService: {
    getPeople: vi.fn().mockResolvedValue({ people: [] }),
    downloadPhoto: service.downloadPhoto,
    downloadSelectedPhotos: service.downloadSelectedPhotos,
  },
}));
vi.mock('../../../services/feedback.service', () => ({
  feedbackService: {
    getGalleryFeedbackSettings: vi.fn().mockResolvedValue({ feedback_enabled: false }),
    getMyFeedback: vi.fn().mockResolvedValue({}),
  },
}));

vi.mock('../GalleryLayout', () => ({
  GalleryLayout: ({ children, headerExtra }: { children?: React.ReactNode; headerExtra?: React.ReactNode }) => (
    <div>{headerExtra}{children}</div>
  ),
}));
vi.mock('../GallerySidebar', () => ({
  GallerySidebar: (props: SidebarProps) => {
    captured.sidebar = props;
    return null;
  },
}));
vi.mock('../PeopleStrip', () => ({ PeopleStrip: () => null }));
vi.mock('../DownloadResolutionModal', () => ({
  DownloadResolutionModal: ({ onClose }: { onClose: () => void }) => (
    <div data-testid="resolution-modal"><button type="button" onClick={onClose}>close-picker</button></div>
  ),
}));
vi.mock('../PhotoGridWithLayouts', () => ({
  PhotoGridWithLayouts: (props: GridProps) => {
    captured.grid = props;
    return null;
  },
}));

import { GalleryView } from '../GalleryView';
import { resetWalkthroughMemory, walkthroughStorageKey } from '../walkthrough/walkthroughStorage';
import { galleryService } from '../../../services/gallery.service';

const event = {
  id: 1,
  event_name: 'Hoa Wedding',
  event_type: 'wedding',
  event_date: '2026-09-19',
  expires_at: '2027-09-19T00:00:00Z',
};

const photo = (id: number) => ({
  id, filename: `IMG_${id}.jpg`, url: `/${id}.jpg`, thumbnail_url: `/t-${id}.jpg`, type: 'photo', size: 1,
  uploaded_at: '2026-09-19T10:00:00Z',
});

function show(eventOverrides: Record<string, unknown> = {}, dataOverrides: Record<string, unknown> = {}) {
  stable.photos = {
    data: {
      event: { ...event, allow_downloads: true, walkthrough_enabled: true, ...eventOverrides },
      categories: [],
      photos: [photo(7), photo(8)],
      ...dataOverrides,
    },
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <GalleryView slug="wedding" event={event} />
    </QueryClientProvider>,
  );
}

/** Every step title, walking the open tour to its end. */
function tourTitles(): string[] {
  const titles: string[] = [];
  for (let i = 0; i < 10; i += 1) {
    titles.push(screen.getByRole('dialog').querySelector('h2')!.textContent || '');
    const next = screen.queryByText('gallery.walkthrough.next');
    if (!next) break;
    fireEvent.click(next);
  }
  return titles.map((title) => title.replace('gallery.walkthrough.steps.', '').replace('.title', ''));
}

const settle = () => new Promise((r) => setTimeout(r, 30));

const helpButton = () => screen.queryByRole('button', { name: 'gallery.walkthrough.help' });

beforeEach(() => {
  resetWalkthroughMemory();
  window.localStorage.clear();
  stable.auth = { logout: () => {}, isClient: false, viaCustomer: false };
  window.history.replaceState(null, '', '/gallery/wedding');
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('GalleryView walkthrough (issue 2551)', () => {
  it('opens once on the first visit, skips with Escape and stays away next time', async () => {
    const first = show();
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('gallery.walkthrough.steps.browse.title');
    expect(window.localStorage.getItem(walkthroughStorageKey('wedding', 'guest'))).toBe('1');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    first.unmount();

    resetWalkthroughMemory();
    show();
    await waitFor(() => expect(helpButton()).not.toBeNull());
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('reopens from the help icon', async () => {
    window.localStorage.setItem(walkthroughStorageKey('wedding', 'guest'), '1');
    show();
    await waitFor(() => expect(helpButton()).not.toBeNull());
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(helpButton()!);
    expect(await screen.findByRole('dialog')).toHaveTextContent('gallery.walkthrough.steps.browse.title');
  });

  it('keeps the client and the guest tour apart, and shows the client the hide step', async () => {
    window.localStorage.setItem(walkthroughStorageKey('wedding', 'guest'), '1');
    stable.auth = { logout: () => {}, isClient: true, viaCustomer: false };
    show();
    await screen.findByRole('dialog');
    expect(window.localStorage.getItem(walkthroughStorageKey('wedding', 'client'))).toBe('1');
    // browse, download, hide, help
    for (let i = 0; i < 2; i += 1) fireEvent.click(screen.getByText('gallery.walkthrough.next'));
    expect(screen.getByRole('dialog')).toHaveTextContent('gallery.walkthrough.steps.hide.title');
  });

  it('still works when storage throws', async () => {
    // Only the walkthrough's keys: other gallery code reads storage too.
    const { getItem, setItem } = Storage.prototype;
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, key: string) {
      if (key.startsWith('picpeak_walkthrough_')) throw new Error('blocked');
      return getItem.call(this, key);
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
      if (key.startsWith('picpeak_walkthrough_')) throw new Error('blocked');
      return setItem.call(this, key, value);
    });
    show();
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });

  it('renders neither tour nor help icon while the gallery has it off', async () => {
    show({ walkthrough_enabled: false });
    await waitFor(() => expect(captured.grid).toBeTruthy());
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(helpButton()).toBeNull();
  });

  it('never shows in an admin preview', async () => {
    window.history.replaceState(null, '', '/gallery/wedding?admin_preview=1');
    show();
    await waitFor(() => expect(captured.grid).toBeTruthy());
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(helpButton()).toBeNull();
  });

  it('waits while the download dialog from a ?download_job= link is open', async () => {
    window.history.replaceState(null, '', `/gallery/wedding?download_job=${'a'.repeat(64)}`);
    show();
    expect(await screen.findByTestId('resolution-modal')).toBeInTheDocument();
    await settle();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(window.localStorage.getItem(walkthroughStorageKey('wedding', 'guest'))).toBeNull();
    fireEvent.click(screen.getByText('close-picker'));
    expect(await screen.findByRole('dialog')).toHaveTextContent('gallery.walkthrough.steps.browse.title');
    expect(window.localStorage.getItem(walkthroughStorageKey('wedding', 'guest'))).toBe('1');
  });

  it('does not use up the first visit while the gallery is hidden until reveal', async () => {
    const hidden = show({}, { hidden_until_reveal: true, photos: [] });
    await settle();
    await settle();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(window.localStorage.getItem(walkthroughStorageKey('wedding', 'guest'))).toBeNull();
    hidden.unmount();

    show();
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });

  it('has a people step only when the people controls are on screen', async () => {
    const getPeople = vi.mocked(galleryService.getPeople);
    const withPeople = (ids: number[]) => ({
      photos: [{ ...photo(7), person_ids: ids }, { ...photo(8), person_ids: ids }],
    });

    // One person and no scan: PeopleStrip renders nothing, no selfie search.
    getPeople.mockResolvedValue({ people: [{ id: 1, face_count: 2 }] } as never);
    const one = show({ people_enabled: true }, withPeople([1]));
    await screen.findByRole('dialog');
    expect(tourTitles()).not.toContain('faces');
    one.unmount();

    resetWalkthroughMemory();
    window.localStorage.clear();
    getPeople.mockResolvedValue({ people: [{ id: 1, face_count: 2 }, { id: 2, face_count: 2 }] } as never);
    show({ people_enabled: true }, withPeople([1, 2]));
    await screen.findByRole('dialog');
    expect(tourTitles()).toContain('faces');
  });

  it('keeps the people step for selfie search with nobody listed yet', async () => {
    vi.mocked(galleryService.getPeople).mockResolvedValue({ people: [] } as never);
    show({ people_enabled: true, selfie_search_enabled: true });
    await screen.findByRole('dialog');
    expect(tourTitles()).toContain('faces');
  });
});
