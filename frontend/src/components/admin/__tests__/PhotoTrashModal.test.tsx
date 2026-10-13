/**
 * The gallery's trash (issue 1733): the list of deleted photos with who
 * deleted them and how long is left, restore and permanent delete for one row
 * or a selection, and the states around it: empty is not "could not load",
 * and a restore that the server refused says why.
 */
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { PhotoTrashModal, daysLeft } from '../PhotoTrashModal';

const getTrash = vi.fn();
const restoreFromTrash = vi.fn();
const purgeFromTrash = vi.fn();
const confirm = vi.fn();
const toastSuccess = vi.fn();
const toastError = vi.fn();

vi.mock('../../common', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../common')>()),
  useConfirm: () => confirm,
}));
vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next');
  return {
    ...actual,
    useTranslation: () => ({
      // The key, with its count when it has one: "admin.photos.trash.daysLeft:29".
      t: (key: string, options?: { count?: number } | string) => (
        typeof options === 'object' && options?.count !== undefined ? `${key}:${options.count}` : key
      ),
      i18n: { language: 'en' },
    }),
  };
});
vi.mock('react-toastify', () => ({
  toast: { success: (...args: unknown[]) => toastSuccess(...args), error: (...args: unknown[]) => toastError(...args) },
}));
vi.mock('../../../hooks/useLocalizedDate', () => ({
  useLocalizedDate: () => ({ format: (value: string) => `date(${value.slice(0, 10)})` }),
}));
// The authenticated image, as the address it would fetch.
vi.mock('../AdminAuthenticatedImage', () => ({
  AdminAuthenticatedImage: ({ src }: { src: string }) => <img data-testid="trash-thumb" data-src={src} alt="" />,
}));
vi.mock('../../../services/photos.service', () => ({
  photosService: {
    getTrash: (...args: unknown[]) => getTrash(...args),
    restoreFromTrash: (...args: unknown[]) => restoreFromTrash(...args),
    purgeFromTrash: (...args: unknown[]) => purgeFromTrash(...args),
  },
}));

const inDays = (days: number) => new Date(Date.now() + days * 86400000 + 3600000).toISOString();
const items = [
  { id: 11, filename: 'IMG_0001.jpg', media_type: 'image', size_bytes: 2048, deleted_at: '2026-10-01T10:00:00.000Z', deleted_by_name: 'anna', purge_after: inDays(29), held: false, thumbnail_url: '/admin/events/7/photos/trash/11/thumbnail' },
  { id: 12, filename: 'clip.mp4', media_type: 'video', size_bytes: 4096, deleted_at: '2026-10-02T10:00:00.000Z', deleted_by_name: null, purge_after: inDays(0), held: true, thumbnail_url: null },
];

const onRestored = vi.fn();
const renderTrash = () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <PhotoTrashModal eventId={7} open onClose={vi.fn()} onRestored={onRestored} />
    </QueryClientProvider>
  );
};

describe('PhotoTrashModal', () => {
  beforeEach(() => {
    [getTrash, restoreFromTrash, purgeFromTrash, confirm, toastSuccess, toastError, onRestored].forEach((fn) => fn.mockReset());
    getTrash.mockResolvedValue({ items, retention_days: 30 });
    confirm.mockResolvedValue(true);
  });

  it('lists each deleted photo with who deleted it and how long is left', async () => {
    renderTrash();
    const first = await screen.findByTestId('photo-trash-row-11');
    expect(getTrash).toHaveBeenCalledWith(7);
    expect(screen.getByText('admin.photos.trash.intro:30')).toBeInTheDocument();
    expect(first).toHaveTextContent('IMG_0001.jpg');
    expect(first).toHaveTextContent('date(2026-10-01)');
    expect(first).toHaveTextContent('anna');
    expect(first).toHaveTextContent('admin.photos.trash.daysLeft:29');
    expect(first).toHaveTextContent('2.0 KB');

    const second = screen.getByTestId('photo-trash-row-12');
    expect(second).toHaveTextContent('admin.photos.trash.unknownUser');
    expect(second).toHaveTextContent('admin.photos.trash.lastDay');
  });

  it('shows the thumbnail the photo still has, and marks one that comes back under review', async () => {
    renderTrash();
    const first = await screen.findByTestId('photo-trash-row-11');
    expect(within(first).getByTestId('trash-thumb')).toHaveAttribute('data-src', '/admin/events/7/photos/trash/11/thumbnail');
    expect(first).not.toHaveTextContent('admin.photos.trash.heldForReview');

    const second = screen.getByTestId('photo-trash-row-12');
    expect(within(second).queryByTestId('trash-thumb')).toBeNull();
    expect(second).toHaveTextContent('admin.photos.trash.heldForReview');
  });

  it('fetches a thumbnail only once its row is near the viewport', async () => {
    let seen: (entries: Array<{ isIntersecting: boolean }>) => void = () => {};
    vi.stubGlobal('IntersectionObserver', class {
      constructor(callback: typeof seen) { seen = callback; }
      observe() {}
      disconnect() {}
    });
    try {
      renderTrash();
      const first = await screen.findByTestId('photo-trash-row-11');
      expect(within(first).queryByTestId('trash-thumb')).toBeNull();
      act(() => seen([{ isIntersecting: true }]));
      expect(within(first).getByTestId('trash-thumb')).toBeInTheDocument();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('says that deleting is final now when the retention is 0 but photos are still listed', async () => {
    getTrash.mockResolvedValue({ items, retention_days: 0 });
    renderTrash();
    await screen.findByTestId('photo-trash-row-11');
    expect(screen.getByText('admin.photos.trash.introOff')).toBeInTheDocument();
  });

  it('restores one photo without asking and tells the gallery to refresh', async () => {
    restoreFromTrash.mockResolvedValue({ restored: 1, photo_ids: [11], failed: [] });
    const user = userEvent.setup();
    renderTrash();
    const row = await screen.findByTestId('photo-trash-row-11');
    await user.click(within(row).getByRole('button', { name: 'admin.photos.trash.restore' }));

    await waitFor(() => expect(onRestored).toHaveBeenCalled());
    expect(restoreFromTrash).toHaveBeenCalledWith(7, [11]);
    expect(confirm).not.toHaveBeenCalled();
    expect(toastSuccess).toHaveBeenCalledWith('admin.photos.trash.restored:1');
  });

  it('says why a photo could not be restored, and leaves the gallery alone', async () => {
    restoreFromTrash.mockResolvedValue({
      restored: 0, photo_ids: [],
      failed: [{ id: 11, filename: 'IMG_0001.jpg', code: 'PHOTO_CAP_REACHED', error: 'This gallery has reached its limit of 1 photos.' }],
    });
    const user = userEvent.setup();
    renderTrash();
    const row = await screen.findByTestId('photo-trash-row-11');
    await user.click(within(row).getByRole('button', { name: 'admin.photos.trash.restore' }));

    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(toastError.mock.calls[0][0]).toContain('admin.photos.trash.restoreFailed:1');
    expect(toastError.mock.calls[0][0]).toContain('reached its limit');
    expect(onRestored).not.toHaveBeenCalled();
  });

  it('deletes a selection permanently only after the confirmation', async () => {
    purgeFromTrash.mockResolvedValue({ purged: 2, failed: [] });
    const user = userEvent.setup();
    renderTrash();
    await screen.findByTestId('photo-trash-row-11');
    // No bulk actions until something is selected.
    expect(screen.queryByRole('button', { name: /purgeSelected/ })).toBeNull();

    await user.click(screen.getByRole('checkbox', { name: 'gallery.selectAll' }));
    confirm.mockResolvedValueOnce(false);
    await user.click(screen.getByRole('button', { name: 'admin.photos.trash.purgeSelected:2' }));
    expect(purgeFromTrash).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'admin.photos.trash.purgeSelected:2' }));
    await waitFor(() => expect(purgeFromTrash).toHaveBeenCalledWith(7, [11, 12]));
    expect(confirm).toHaveBeenLastCalledWith(expect.objectContaining({
      variant: 'danger', message: 'admin.photos.trash.purgeConfirm:2',
    }));
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith('admin.photos.trash.purged:2'));
  });

  it('restores a selection in one request', async () => {
    restoreFromTrash.mockResolvedValue({ restored: 1, photo_ids: [12], failed: [] });
    const user = userEvent.setup();
    renderTrash();
    await screen.findByTestId('photo-trash-row-12');
    await user.click(screen.getByRole('checkbox', { name: 'clip.mp4' }));
    await user.click(screen.getByRole('button', { name: 'admin.photos.trash.restoreSelected:1' }));
    await waitFor(() => expect(restoreFromTrash).toHaveBeenCalledWith(7, [12]));
  });

  describe('a selection larger than one request may name', () => {
    const many = Array.from({ length: 501 }, (_, index) => ({ ...items[0], id: 1000 + index, filename: `IMG_${index}.jpg` }));
    const ids = many.map((item) => item.id);
    const selectAll = async () => {
      getTrash.mockResolvedValue({ items: many, retention_days: 30 });
      const user = userEvent.setup();
      renderTrash();
      await screen.findByTestId('photo-trash-row-1000');
      await user.click(screen.getByRole('checkbox', { name: 'gallery.selectAll' }));
      return user;
    };

    it('restores it in requests of at most 500 and adds the results up', async () => {
      restoreFromTrash.mockImplementation(async (_eventId: number, batch: number[]) => ({ restored: batch.length, photo_ids: batch, failed: [] }));
      const user = await selectAll();
      await user.click(screen.getByRole('button', { name: 'admin.photos.trash.restoreSelected:501' }));

      await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith('admin.photos.trash.restored:501'));
      expect(restoreFromTrash.mock.calls).toEqual([[7, ids.slice(0, 500)], [7, ids.slice(500)]]);
      expect(toastError).not.toHaveBeenCalled();
    }, 30000);

    it('deletes it in requests of at most 500, and reports what a failed request left', async () => {
      purgeFromTrash.mockResolvedValueOnce({ purged: 500, failed: [] }).mockRejectedValueOnce(new Error('offline'));
      const user = await selectAll();
      await user.click(screen.getByRole('button', { name: 'admin.photos.trash.purgeSelected:501' }));

      await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith('admin.photos.trash.purged:500'));
      expect(purgeFromTrash.mock.calls).toEqual([[7, ids.slice(0, 500)], [7, ids.slice(500)]]);
      expect(toastError).toHaveBeenCalledWith('admin.photos.trash.purgeFailed');
    }, 30000);
  });

  it('shows the empty state for an empty trash', async () => {
    getTrash.mockResolvedValue({ items: [], retention_days: 30 });
    renderTrash();
    expect(await screen.findByText('admin.photos.trash.empty')).toBeInTheDocument();
    expect(screen.queryByTestId('photo-trash-table')).toBeNull();
  });

  it('shows an error with Retry, not the empty state, when loading fails', async () => {
    getTrash.mockRejectedValue(new Error('offline'));
    renderTrash();
    expect(await screen.findByText('admin.photos.trash.loadFailed')).toBeInTheDocument();
    expect(screen.queryByText('admin.photos.trash.empty')).toBeNull();
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
  });

  it('counts whole days until the purge, and none once it is due', () => {
    const now = Date.parse('2026-10-12T12:00:00.000Z');
    expect(daysLeft('2026-10-14T13:00:00.000Z', now)).toBe(2);
    expect(daysLeft('2026-10-12T18:00:00.000Z', now)).toBe(0);
    expect(daysLeft('2026-10-01T00:00:00.000Z', now)).toBe(0);
    expect(daysLeft('not a date', now)).toBe(0);
  });
});
