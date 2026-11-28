/**
 * One feature toolbox for every layout (issue 2543). Premium and Story return
 * before the standard toolbar, so the same search, sort, filter panel and
 * people row reach them through `beforeGrid`, the row between their hero and
 * their photos, driven by the gallery's own state: what they narrow is the
 * list the layout is handed. Each part follows the gate the standard layouts
 * have for it.
 */
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const stable = vi.hoisted(() => ({
  auth: { logout: () => {}, endSession: () => {}, isClient: false, viaCustomer: false, viaClientPin: false,
    enterClientMode: () => {}, leaveClientMode: () => {} },
  theme: { setTheme: () => {}, theme: { galleryLayout: 'gallery-premium' } as { galleryLayout: string } },
  download: { mutate: () => {}, isPending: false },
  settings: { data: {} as Record<string, unknown> },
  watermark: { watermarkEnabled: false },
  t: (key: string, options?: unknown) => {
    const count = (options as { count?: number } | undefined)?.count;
    return count === undefined ? key : `${key}:${count}`;
  },
  photos: null as unknown,
  // Premium's own category tab, as the layout applies it before the row.
  tab: null as string | null,
  grid: null as unknown as { selectedPhotos: Set<number>; isSelectionMode: boolean },
}));

const archives = vi.hoisted(() => ({
  downloadPhotosInParts: vi.fn().mockResolvedValue(true),
  downloadSelectedPhotos: vi.fn().mockResolvedValue(true),
}));
vi.mock('../../../contexts/ArchiveDownloadContext', () => ({
  ArchiveDownloadProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ArchiveDownloadDialog: () => null,
  useArchiveDownload: () => archives,
}));

const people = vi.hoisted(() => ({
  people: [
    { id: 1, label: 'Hoa', face_count: 2, cover: null },
    { id: 2, label: 'Minh', face_count: 2, cover: null },
  ],
  scan: { in_progress: false, scanned: 4, total: 4 },
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
  galleryService: { getPeople: vi.fn().mockResolvedValue(people) },
}));
vi.mock('../../../services/feedback.service', () => ({
  feedbackService: {
    getGalleryFeedbackSettings: vi.fn().mockResolvedValue({
      feedback_enabled: true, allow_likes: true, allow_ratings: true, identity_mode: 'simple',
    }),
    getMyFeedback: vi.fn().mockResolvedValue([]),
  },
}));
vi.mock('../../common/AuthenticatedImage', () => ({ AuthenticatedImage: () => null }));
vi.mock('../PhotoGridWithLayouts', () => ({
  PhotoGridWithLayouts: (props: {
    photos: Array<{ id: number; category_name?: string }>;
    beforeGrid?: React.ReactNode | ((shown: Array<{ id: number }>) => React.ReactNode);
    selectedPhotos: Set<number>;
    isSelectionMode: boolean;
    openPhotoId?: number | null;
  }) => {
    const { photos: shown, beforeGrid } = props;
    stable.grid = props;
    const visible = stable.tab ? shown.filter((p) => p.category_name === stable.tab) : shown;
    return (
      <div data-testid="photo-grid" data-ids={shown.map((p) => p.id).join(',')} data-open={props.openPhotoId ?? ''}>
        <div data-testid="before-grid">{typeof beforeGrid === 'function' ? beforeGrid(visible) : beforeGrid}</div>
      </div>
    );
  },
}));

import { GalleryView } from '../GalleryView';

const event = { id: 1, event_name: 'Hoa Wedding', event_type: 'wedding', event_date: '2026-09-19', expires_at: '2027-09-19T00:00:00Z' };

const photo = (id: number, filename: string, personIds: number[], likes = 0) => ({
  id, filename, url: `/${filename}`, thumbnail_url: `/t-${filename}`, type: 'photo', size: 1,
  // These layouts' Liked filter keeps the viewer's own likes (is_liked).
  uploaded_at: `2026-09-19T1${id}:00:00Z`, like_count: likes, is_liked: likes > 0, person_ids: personIds,
  category_name: id <= 2 ? 'Ceremony' : 'Party',
  // The viewer's own rating: only photo 1 is rated, five stars.
  my_rating: id === 1 ? 5 : null,
});

function show(layout: string, { peopleEnabled = true, filterBar = true } = {}) {
  stable.theme.theme = { galleryLayout: layout };
  stable.settings = { data: filterBar ? {} : { gallery_show_filter_bar: false } };
  stable.photos = {
    data: {
      event: { ...event, allow_downloads: true, people_enabled: peopleEnabled },
      categories: [],
      photos: [
        photo(1, 'ceremony.jpg', [1], 2),
        photo(2, 'dinner.jpg', [2]),
        photo(3, 'dance.jpg', [1, 2], 1),
        photo(4, 'cake.jpg', []),
      ],
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

const row = () => within(screen.getByTestId('before-grid'));
const shownIds = () => screen.getByTestId('photo-grid').getAttribute('data-ids');

afterEach(() => {
  cleanup();
  stable.tab = null;
  vi.clearAllMocks();
});

describe.each(['gallery-premium', 'gallery-story', 'gallery-folio'])('feature toolbox on %s', (layout) => {
  it('puts search, sort, filters and the people row above the photos', async () => {
    show(layout);
    const toolbar = row().getByTestId('gallery-toolbar');
    expect(within(toolbar).getByRole('textbox', { name: 'gallery.searchPhotos' })).toBeInTheDocument();
    expect(within(toolbar).getByRole('button', { name: 'gallery.sortByDate' })).toBeInTheDocument();
    // The filter panel follows the feedback settings, which arrive later.
    expect(await within(toolbar).findByRole('button', { name: 'gallery.filters' })).toBeInTheDocument();
    expect(await row().findByText('gallery.people.title')).toBeInTheDocument();
    // Browse face only: selection stays in the layout's own nav.
    expect(toolbar).toHaveAttribute('data-mode', 'browse');
    expect(within(toolbar).queryByRole('button', { name: /gallery\.select/ })).toBeNull();
  });

  it('narrows the photos the layout gets: search, a person, a feedback filter', async () => {
    show(layout);
    expect(shownIds()).toBe('4,3,2,1');

    fireEvent.change(row().getByRole('textbox', { name: 'gallery.searchPhotos' }), { target: { value: 'd' } });
    expect(shownIds()).toBe('3,2');
    fireEvent.change(row().getByRole('textbox', { name: 'gallery.searchPhotos' }), { target: { value: '' } });

    const [hoa] = await row().findAllByRole('button', { name: 'gallery.people.filterBy' });
    fireEvent.click(hoa);
    expect(shownIds()).toBe('3,1');
    // The active-filter row states it, with the count the layout shows.
    expect(row().getByRole('status')).toHaveTextContent('gallery.people.matchCount:2');
    fireEvent.click(row().getByRole('button', { name: 'gallery.people.clear' }));
    expect(shownIds()).toBe('4,3,2,1');

    fireEvent.click(await row().findByRole('button', { name: 'gallery.filters' }));
    fireEvent.click(screen.getByRole('button', { name: 'feedback.likes' }));
    await waitFor(() => expect(shownIds()).toBe('3,1'));
  });

  it('leaves out search, sort and filters when the filter bar is off', async () => {
    show(layout, { filterBar: false });
    expect(await row().findByText('gallery.people.title')).toBeInTheDocument();
    expect(screen.queryByTestId('gallery-toolbar')).toBeNull();
    expect(screen.queryByRole('textbox', { name: 'gallery.searchPhotos' })).toBeNull();
  });

  it('leaves out the people row when people are off', async () => {
    show(layout, { peopleEnabled: false });
    expect(await row().findByRole('button', { name: 'gallery.filters' })).toBeInTheDocument();
    expect(screen.queryByText('gallery.people.title')).toBeNull();
    expect(row().queryByRole('button', { name: 'gallery.people.filterBy' })).toBeNull();
  });

  it('renders no row at all with both off', () => {
    show(layout, { peopleEnabled: false, filterBar: false });
    expect(screen.getByTestId('before-grid')).toBeEmptyDOMElement();
  });
});

describe('feature toolbox under a Premium category tab', () => {
  it('"Select these N" picks the photos the tab shows, not the ones it hides', async () => {
    stable.tab = 'Ceremony';
    show('gallery-premium');
    fireEvent.click(await row().findByRole('button', { name: 'gallery.filters' }));
    fireEvent.click(screen.getByRole('button', { name: 'gallery.filterPanel.selectMatches:2' }));
    expect(stable.grid.isSelectionMode).toBe(true);
    expect([...stable.grid.selectedPhotos].sort()).toEqual([1, 2]);
  });

  it('"Download these N" covers only the photos the tab shows', async () => {
    stable.tab = 'Ceremony';
    show('gallery-premium');
    const [hoa] = await row().findAllByRole('button', { name: 'gallery.people.filterBy' });
    fireEvent.click(hoa);
    // Hoa is in photos 1 and 3; the Ceremony tab shows only 1.
    expect(shownIds()).toBe('3,1');
    expect(row().getByRole('status')).toHaveTextContent('gallery.people.matchCount:1');
    fireEvent.click(row().getByRole('button', { name: 'gallery.people.downloadThese:1' }));
    await waitFor(() => expect(archives.downloadPhotosInParts).toHaveBeenCalledWith('wedding', [1]));
  });
});

describe('search by category name', () => {
  it('finds a Story scene by its name, as Story always did', () => {
    show('gallery-story');
    fireEvent.change(row().getByRole('textbox', { name: 'gallery.searchPhotos' }), { target: { value: 'ceremony' } });
    expect(shownIds()).toBe('2,1');
  });

  it('stays a filename search in the other layouts', () => {
    show('gallery-premium');
    fireEvent.change(row().getByRole('textbox', { name: 'gallery.searchPhotos' }), { target: { value: 'ceremony' } });
    expect(shownIds()).toBe('1');
  });
});

describe('photo links and the rating filter', () => {
  it('clears a minimum rating that hides the linked photo', async () => {
    show('gallery-premium');
    fireEvent.click(await row().findByRole('button', { name: 'gallery.filters' }));
    const chips = await screen.findAllByRole('button', { name: 'gallery.filterByMinRating' });
    fireEvent.click(chips[chips.length - 1]);
    await waitFor(() => expect(shownIds()).toBe('1'));

    // Forward to a photo opened before the filter.
    act(() => {
      window.history.pushState({}, '', '?photo=2');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await waitFor(() => expect(screen.getByTestId('photo-grid')).toHaveAttribute('data-open', '2'));
    expect(shownIds()).toContain('2');
    window.history.replaceState({}, '', '/');
  });
});
