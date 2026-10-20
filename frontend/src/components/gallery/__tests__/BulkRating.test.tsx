/**
 * "Rate selected" (issue 1733): one star press rates the selection through the
 * bulk route and writes the result into the cached gallery-photos lists in
 * place, without refetching the gallery.
 */
import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { toast } from 'react-toastify';

import { BulkRating } from '../BulkRating';
import { GallerySidebar } from '../GallerySidebar';
import { feedbackService } from '../../../services/feedback.service';
import { getGuestIdentity } from '../../../utils/guestIdentityStorage';
import type { GalleryData, Photo } from '../../../types';

vi.mock('../../../contexts/GuestIdentityContext', () => ({
  useGuestIdentityOptional: () => null,
}));

vi.mock('../../../utils/guestIdentityStorage', () => ({ getGuestIdentity: vi.fn(() => null) }));

vi.mock('../../../services/feedback.service', () => ({
  BULK_RATING_MAX_PHOTOS: 200,
  feedbackService: { submitBulkRating: vi.fn() },
}));

vi.mock('react-toastify', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next');
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string, fallback?: unknown, opts?: Record<string, unknown>) => {
        const vars = (typeof fallback === 'object' && fallback ? fallback : opts) as Record<string, unknown> | undefined;
        const text = typeof fallback === 'string' ? fallback : key;
        return text.replace(/\{\{(\w+)\}\}/g, (_m, k) => String(vars?.[k] ?? ''));
      },
      i18n: { language: 'en' },
    }),
  };
});

const SLUG = 'x';
const LIST_KEY = ['gallery-photos', SLUG, 'all', undefined];
const submit = vi.mocked(feedbackService.submitBulkRating);

function makePhoto(id: number, patch: Partial<Photo> = {}): Photo {
  return {
    id,
    filename: `IMG_${id}.jpg`,
    url: `/api/gallery/x/photo/${id}`,
    thumbnail_url: `/api/gallery/x/thumbnail/${id}`,
    type: 'individual',
    size: 1,
    uploaded_at: '2026-01-01T00:00:00Z',
    my_rating: null,
    average_rating: 0,
    total_ratings: 0,
    ...patch,
  } as Photo;
}

let queryClient: QueryClient;
const listFetch = vi.fn();

function seedCache(photos: Photo[]) {
  queryClient.setQueryData(LIST_KEY, { event: { id: 1 }, photos } as unknown as GalleryData);
}
const cached = () => queryClient.getQueryData<GalleryData>(LIST_KEY)!.photos;
const ok = (ids: number[], rating: number, extra: object = {}) => ({
  success: true, rating, results: ids.map((id) => ({ photo_id: id, success: true, ...extra })),
});

function renderControl(photoIds: number[], props: Partial<React.ComponentProps<typeof BulkRating>> = {}) {
  return render(
    <QueryClientProvider client={queryClient}>
      <BulkRating slug={SLUG} photoIds={photoIds} {...props} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, queryFn: listFetch, staleTime: Infinity } } });
});

describe('BulkRating', () => {
  it('rates the selection in one request and patches only those rows', async () => {
    seedCache([makePhoto(1), makePhoto(2, { my_rating: 2 }), makePhoto(3, { my_rating: 1, average_rating: 1, total_ratings: 1 })]);
    submit.mockResolvedValue(ok([1, 2], 4, { average_rating: 4, total_ratings: 1 }));
    renderControl([1, 2]);

    fireEvent.click(screen.getByRole('button', { name: 'Rate 4 stars' }));

    await waitFor(() => expect(cached()[0].my_rating).toBe(4));
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledWith(SLUG, [1, 2], 4, { guest_name: undefined, guest_email: undefined });
    expect(cached().map((p) => [p.my_rating, p.average_rating, p.total_ratings])).toEqual([
      [4, 4, 1], [4, 4, 1], [1, 1, 1],
    ]);
    expect(listFetch).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });

  // The lightbox's feedback panel reads the rating from its own per-photo
  // query; one that is open, or cached from an earlier look, would keep the
  // stars from before the bulk rating.
  it('marks the per-photo feedback of the gallery stale', async () => {
    seedCache([makePhoto(1)]);
    queryClient.setQueryData(['photo-feedback', SLUG, '1'], { my_feedback: { rating: 2 } });
    submit.mockResolvedValue(ok([1], 5));
    renderControl([1]);

    fireEvent.click(screen.getByRole('button', { name: 'Rate 5 stars' }));
    await waitFor(() => expect(queryClient.getQueryState(['photo-feedback', SLUG, '1'])?.isInvalidated).toBe(true));
  });

  it('keeps the list aggregates when the gallery does not share them', async () => {
    seedCache([makePhoto(1, { average_rating: 3, total_ratings: 2 })]);
    submit.mockResolvedValue(ok([1], 5));
    renderControl([1]);

    fireEvent.click(screen.getByRole('button', { name: 'Rate 5 stars' }));

    await waitFor(() => expect(cached()[0].my_rating).toBe(5));
    expect(cached()[0]).toMatchObject({ average_rating: 3, total_ratings: 2 });
  });

  it('clears the rating of the selection', async () => {
    seedCache([makePhoto(1, { my_rating: 3 })]);
    submit.mockResolvedValue({ success: true, rating: 0, results: [{ photo_id: 1, success: true }] });
    renderControl([1]);

    fireEvent.click(screen.getByRole('button', { name: 'Remove rating' }));

    await waitFor(() => expect(cached()[0].my_rating).toBeNull());
    expect(submit).toHaveBeenCalledWith(SLUG, [1], 0, expect.anything());
  });

  it('says so when the rating limit is reached and leaves the rows alone', async () => {
    seedCache([makePhoto(1), makePhoto(2)]);
    submit.mockRejectedValue({ response: { status: 429 } });
    renderControl([1, 2]);

    fireEvent.click(screen.getByRole('button', { name: 'Rate 3 stars' }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Rating limit reached. Try again later.'));
    expect(cached().map((p) => p.my_rating)).toEqual([null, null]);
  });

  it('leaves a photo the server refused unrated and reports the shortfall', async () => {
    seedCache([makePhoto(1), makePhoto(2)]);
    submit.mockResolvedValue({
      success: true, rating: 4,
      results: [{ photo_id: 1, success: true }, { photo_id: 2, success: false, error: 'Photo not found' }],
    });
    renderControl([1, 2]);

    fireEvent.click(screen.getByRole('button', { name: 'Rate 4 stars' }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('1 of 2 photos were rated'));
    expect(cached().map((p) => p.my_rating)).toEqual([4, null]);
  });

  it('sends a selection above the server cap in several requests', async () => {
    const ids = Array.from({ length: 450 }, (_, i) => i + 1);
    seedCache(ids.map((id) => makePhoto(id)));
    submit.mockImplementation(async (_slug, chunk, rating) => ok(chunk, rating));
    renderControl(ids);

    fireEvent.click(screen.getByRole('button', { name: 'Rate 2 stars' }));

    await waitFor(() => expect(cached()[449].my_rating).toBe(2));
    expect(submit.mock.calls.map((call) => call[1].length)).toEqual([200, 200, 50]);
  });

  // The API client reads the stored guest token per request, so a guest
  // switched in another tab would get the rest of the run filed under them.
  it('stops between requests when the guest on this device changes, and patches nothing', async () => {
    const ids = Array.from({ length: 450 }, (_, i) => i + 1);
    seedCache(ids.map((id) => makePhoto(id)));
    const stored = vi.mocked(getGuestIdentity);
    stored.mockReturnValue({ id: 1 } as ReturnType<typeof getGuestIdentity>);
    submit.mockImplementation(async (_slug, chunk, rating) => {
      stored.mockReturnValue({ id: 2 } as ReturnType<typeof getGuestIdentity>);
      return ok(chunk as number[], rating as number);
    });
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    renderControl(ids);

    fireEvent.click(screen.getByRole('button', { name: 'Rate 2 stars' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Rate 2 stars' })).toHaveProperty('disabled', false));
    expect(submit).toHaveBeenCalledTimes(1);
    expect(cached().every((photo) => photo.my_rating === null)).toBe(true);
    expect(invalidate).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
    stored.mockReturnValue(null);
  });

  // Each request's rows are written when it answers. Held back to the end
  // of the run, the write would land on top of a rating the viewer gave one
  // of the early photos on its tile while the later requests were still out.
  it('writes each request as it answers, so a later tile rating is not overwritten', async () => {
    const ids = Array.from({ length: 201 }, (_, i) => i + 1);
    seedCache(ids.map((id) => makePhoto(id)));
    let releaseSecond: (value: ReturnType<typeof ok>) => void = () => {};
    submit
      .mockResolvedValueOnce(ok(ids.slice(0, 200), 5))
      .mockImplementationOnce(() => new Promise((resolve) => { releaseSecond = resolve; }) as never);
    renderControl(ids);

    fireEvent.click(screen.getByRole('button', { name: 'Rate 5 stars' }));
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(2));
    expect(cached()[0].my_rating).toBe(5);
    expect(cached()[200].my_rating).toBeNull();

    // What TileRating does for photo 1 in the meantime.
    queryClient.setQueryData<GalleryData>(LIST_KEY, (old) => ({
      ...old!, photos: old!.photos.map((p) => (p.id === 1 ? { ...p, my_rating: 3 } : p)),
    }));
    releaseSecond(ok([201], 5));
    await waitFor(() => expect(cached()[200].my_rating).toBe(5));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Rate 5 stars' })).toHaveProperty('disabled', false));
    expect(cached()[0].my_rating).toBe(3);
  });

  // Offline, React Query parks the mutation and runs it on reconnect, with
  // whatever the component last rendered. The press decides what is rated
  // and for whom, not the moment the network returns.
  it('rates the selection as it was at the press when the request waits for the network', async () => {
    seedCache([makePhoto(1), makePhoto(2), makePhoto(3)]);
    submit.mockImplementation(async (_slug, chunk, rating) => ok(chunk as number[], rating as number));
    onlineManager.setOnline(false);
    try {
      const view = renderControl([1, 2]);
      fireEvent.click(screen.getByRole('button', { name: 'Rate 4 stars' }));
      view.rerender(
        <QueryClientProvider client={queryClient}>
          <BulkRating slug={SLUG} photoIds={[3]} />
        </QueryClientProvider>,
      );
      expect(submit).not.toHaveBeenCalled();
      onlineManager.setOnline(true);
      await waitFor(() => expect(cached()[0].my_rating).toBe(4));
      expect(submit.mock.calls.map((call) => call[1])).toEqual([[1, 2]]);
      expect(cached()[2].my_rating).toBeNull();
      expect(toast.error).not.toHaveBeenCalled();
    } finally {
      onlineManager.setOnline(true);
    }
  });

  it('sends nothing when the guest changed while the request waited for the network', async () => {
    seedCache([makePhoto(1)]);
    submit.mockResolvedValue(ok([1], 4));
    const stored = vi.mocked(getGuestIdentity);
    stored.mockReturnValue({ id: 1 } as ReturnType<typeof getGuestIdentity>);
    onlineManager.setOnline(false);
    try {
      renderControl([1]);
      fireEvent.click(screen.getByRole('button', { name: 'Rate 4 stars' }));
      stored.mockReturnValue({ id: 2 } as ReturnType<typeof getGuestIdentity>);
      onlineManager.setOnline(true);
      await waitFor(() => expect(screen.getByRole('button', { name: 'Rate 4 stars' })).toHaveProperty('disabled', false));
      expect(submit).not.toHaveBeenCalled();
      expect(cached()[0].my_rating).toBeNull();
    } finally {
      onlineManager.setOnline(true);
      stored.mockReturnValue(null);
    }
  });

  it('keeps a run that is still out guarded when the control is closed and reopened', async () => {
    let answer: (value: ReturnType<typeof ok>) => void = () => {};
    submit.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
    seedCache([makePhoto(1)]);
    const first = renderControl([1]);
    fireEvent.click(screen.getByRole('button', { name: 'Rate 4 stars' }));
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    first.unmount();
    renderControl([1]);
    expect(screen.getByRole('button', { name: 'Rate 2 stars' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Rate 2 stars' }));
    expect(submit).toHaveBeenCalledTimes(1);
    answer(ok([1], 4));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Rate 2 stars' })).not.toBeDisabled());
    expect(cached()[0].my_rating).toBe(4);
  });

  it('tells its host while the name-and-email dialog is open', async () => {
    seedCache([makePhoto(1)]);
    const onDialogChange = vi.fn();
    renderControl([1], { requireNameEmail: true, onDialogChange });
    expect(onDialogChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Rate 4 stars' }));
    await screen.findByRole('dialog');
    expect(onDialogChange).toHaveBeenLastCalledWith(true);
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(onDialogChange).toHaveBeenLastCalledWith(false);
  });

  it('rates under the name and email its host kept, without asking again', async () => {
    seedCache([makePhoto(1)]);
    submit.mockResolvedValue(ok([1], 4));
    renderControl([1], {
      requireNameEmail: true,
      identity: { name: 'Ann', email: 'ann@example.com' },
      onIdentityChange: vi.fn(),
    });
    fireEvent.click(screen.getByRole('button', { name: 'Rate 4 stars' }));
    await waitFor(() => expect(submit).toHaveBeenCalledWith(SLUG, [1], 4, { guest_name: 'Ann', guest_email: 'ann@example.com' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('asks for name and email first when the gallery requires them', async () => {
    seedCache([makePhoto(1)]);
    submit.mockResolvedValue(ok([1], 4));
    renderControl([1], { requireNameEmail: true });

    fireEvent.click(screen.getByRole('button', { name: 'Rate 4 stars' }));
    expect(submit).not.toHaveBeenCalled();
    expect(await screen.findByRole('dialog')).toBeTruthy();
  });
});

describe('GallerySidebar', () => {
  const sidebar = (extra: Partial<React.ComponentProps<typeof GallerySidebar>>) => render(
    <QueryClientProvider client={queryClient}>
      <GallerySidebar
        isOpen
        onClose={() => {}}
        categories={[]}
        selectedCategoryId={null}
        onCategoryChange={() => {}}
        searchTerm=""
        onSearchChange={() => {}}
        sortBy="date"
        onSortChange={() => {}}
        isSelectionMode
        onToggleSelectionMode={() => {}}
        selectedCount={2}
        onDownloadAll={() => {}}
        onDownloadSelected={() => {}}
        isDownloading={false}
        allowDownloads
        totalPhotos={3}
        isMobile={false}
        {...extra}
      />
    </QueryClientProvider>,
  );

  it('offers "Rate selected" next to the selection actions when ratings are on', () => {
    sidebar({ bulkRating: { slug: SLUG, photoIds: [1, 2] } });
    expect(screen.getByRole('group', { name: 'Rate selected' })).toBeTruthy();
  });

  it('does not offer it with ratings off or nothing selected', () => {
    const { unmount } = sidebar({});
    expect(screen.queryByRole('group', { name: 'Rate selected' })).toBeNull();
    unmount();
    sidebar({ bulkRating: { slug: SLUG, photoIds: [] }, selectedCount: 0 });
    expect(screen.queryByRole('group', { name: 'Rate selected' })).toBeNull();
  });

  // A proofing gallery often has downloads off; the tile checkboxes still
  // select there, and rating is not a download action.
  it('offers it with downloads off', () => {
    sidebar({ allowDownloads: false, bulkRating: { slug: SLUG, photoIds: [1, 2] } });
    expect(screen.getByRole('group', { name: 'Rate selected' })).toBeTruthy();
  });

  // The drawer slides with a CSS transform, which would confine a fixed
  // overlay rendered inside it to the drawer.
  it('opens the identity dialog outside the drawer, and a press in it leaves the drawer open', async () => {
    const onClose = vi.fn();
    const { container } = sidebar({
      isMobile: true,
      onClose,
      bulkRating: { slug: SLUG, photoIds: [1, 2], requireNameEmail: true },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Rate 4 stars' }));
    const dialog = await screen.findByRole('dialog');
    expect(container.querySelector('.gallery-sidebar')!.contains(dialog)).toBe(false);

    fireEvent.mouseDown(dialog);
    expect(onClose).not.toHaveBeenCalled();
    // A press on the page behind the drawer still closes it.
    fireEvent.mouseDown(document.body);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
