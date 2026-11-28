/**
 * Gallery Folio in the gallery shell (issue 2617). A full-page layout like
 * Premium and Story: the shell steps aside, the folder strip above it takes
 * Folio's palette, opening a folder narrows the photos it is handed, and its
 * nav heart filters the viewer's own likes.
 */
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

type PhotosResult = { data: unknown; isLoading: boolean; error: unknown; refetch: () => void };

const stable = vi.hoisted(() => ({
  auth: { logout: () => {}, endSession: () => {}, isClient: false, viaCustomer: false, viaClientPin: false,
    enterClientMode: vi.fn(), leaveClientMode: vi.fn() },
  theme: {
    setTheme: () => {},
    theme: { galleryLayout: 'gallery-folio', gallerySettings: { folioPalette: 'charcoal' } } as Record<string, unknown>,
  },
  download: { mutate: () => {}, isPending: false },
  settings: { data: {} },
  watermark: { watermarkEnabled: false },
  t: (key: string) => key,
  photos: null as unknown as PhotosResult,
  grid: null as unknown as {
    photos: Array<{ id: number }>;
    onToggleLikedOnly?: () => void;
    likedOnly?: boolean;
    copyFilenamesCount?: number;
    beforeGrid?: React.ReactNode | ((shown: Array<{ id: number }>) => React.ReactNode);
  },
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
    getGalleryFeedbackSettings: vi.fn().mockResolvedValue({ feedback_enabled: true, allow_likes: true, identity_mode: 'simple' }),
    getMyFeedback: vi.fn().mockResolvedValue([]),
  },
}));
vi.mock('../GalleryLayout', () => ({
  GalleryLayout: ({ children }: { children?: React.ReactNode }) => <div data-testid="standard-shell">{children}</div>,
}));
vi.mock('../PhotoGridWithLayouts', () => ({
  PhotoGridWithLayouts: (props: typeof stable.grid) => {
    stable.grid = props;
    const { beforeGrid } = props;
    return (
      <div data-testid="photo-grid" data-ids={props.photos.map((p) => p.id).join(',')}>
        <div data-testid="before-grid">{typeof beforeGrid === 'function' ? beforeGrid(props.photos) : beforeGrid}</div>
      </div>
    );
  },
}));

import { GalleryView } from '../GalleryView';

const event = { id: 1, event_name: 'Hoa Wedding', event_type: 'wedding', event_date: '2026-09-19', expires_at: '2027-09-19T00:00:00Z' };

const photo = (id: number, folder: number | null, liked = false, likeCount = 0, category: number | null = null, favorites = 0) => ({
  id, filename: `${id}.jpg`, url: `/${id}.jpg`, thumbnail_url: `/${id}-t.jpg`, type: 'photo', size: 1,
  uploaded_at: `2026-09-19T1${id}:00:00Z`, category_id: category, folder_id: folder,
  is_liked: liked, like_count: likeCount, favorite_count: favorites,
});

function show({ filterBar = true } = {}) {
  stable.settings = { data: filterBar ? {} : { gallery_show_filter_bar: false } };
  stable.photos = {
    data: {
      event: { ...event, allow_downloads: true },
      categories: [
        { id: 3, name: 'Ceremony', slug: 'ceremony', is_folder: true, parent_id: null },
        { id: 9, name: 'Party', slug: 'party', is_folder: false, parent_id: null },
      ],
      // 5 is liked by this viewer; 6 only by someone else, and in Party.
      // 4 and 6 are bookmarked (favourite feedback, from the lightbox).
      photos: [photo(4, 3, false, 0, null, 1), photo(5, null, true, 1), photo(6, null, false, 2, 9, 1)],
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

const shownIds = () => screen.getByTestId('photo-grid').getAttribute('data-ids');

afterEach(() => {
  cleanup();
  // Opening a folder writes it to the URL.
  window.history.replaceState({}, '', '/');
});

describe('Gallery Folio in the gallery shell', () => {
  it('draws its own page, without the standard shell', () => {
    show();
    expect(screen.queryByTestId('standard-shell')).toBeNull();
    expect(screen.getByTestId('photo-grid')).toBeInTheDocument();
  });

  it('paints the folder strip in its palette, and a folder narrows its photos', () => {
    show();
    expect(shownIds()).toBe('6,5');
    const tile = screen.getByRole('button', { name: 'gallery.openFolder' });
    // The strip sits in a box that carries Folio's charcoal palette.
    const scope = tile.closest('[style*="--color-background"]') as HTMLElement;
    expect(scope.style.getPropertyValue('--color-background')).toBe('#1c1c1b');

    fireEvent.click(tile);
    expect(shownIds()).toBe('4');
  });

  it('keeps the folder strip under the shared lightbox', () => {
    // Folio opens photos in the shared lightbox (z-50); the strip's raise
    // above Story's fixed nav would leave its buttons on top of the viewer.
    show();
    const band = screen.getByRole('button', { name: 'gallery.openFolder' }).closest('.pointer-events-none') as HTMLElement;
    expect(band).not.toHaveClass('z-[60]');
  });

  it.each([true, false])('offers the gallery\'s categories above the photos (filter bar %s)', (filterBar) => {
    // Folio has no tabs or scenes of its own: the chips are its way to a category.
    show({ filterBar });
    const party = within(screen.getByTestId('before-grid')).getByRole('button', { name: 'Party (1)' });
    fireEvent.click(party);
    expect(shownIds()).toBe('6');
  });

  it('lists the bookmarked photos for Copy filenames, not the liked ones', async () => {
    // Folio's lightbox writes favourite feedback: unlike Premium and Story,
    // a like is not its favourite, even though its heart filters own likes.
    show();
    await waitFor(() => expect(stable.grid.copyFilenamesCount).toBe(2));
  });

  it('filters the viewer\'s own likes from its nav heart', () => {
    show();
    act(() => stable.grid.onToggleLikedOnly?.());
    expect(stable.grid.likedOnly).toBe(true);
    // Photo 6 has likes, but not this viewer's.
    expect(shownIds()).toBe('5');
  });
});
