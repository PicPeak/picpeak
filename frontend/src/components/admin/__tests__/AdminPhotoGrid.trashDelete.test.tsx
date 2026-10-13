/**
 * Deleting from the admin grid with the photo trash on (issue 1733): the
 * confirmation says the photos go to the trash and for how long, the toast
 * says what the server did, and a photo that could not be deleted is
 * reported. Without a retention the wording stays "cannot be undone".
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { AdminPhotoGrid } from '../AdminPhotoGrid';
import type { AdminPhoto } from '../../../services/photos.service';

const deletePhotos = vi.fn();
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
      // Keys under the trash namespace come back as "key:count[:forDays]";
      // everything else as its English fallback, as the grid's other tests read it.
      t: (key: string, a?: unknown, b?: unknown) => {
        const options = (typeof a === 'object' && a ? a : b) as { count?: number; forDays?: string } | undefined;
        if (key.startsWith('admin.photos.trash.')) {
          return [key, options?.count, options?.forDays].filter((part) => part !== undefined).join('|');
        }
        return typeof a === 'string' ? a : key;
      },
      i18n: { language: 'en' },
    }),
  };
});
vi.mock('react-toastify', () => ({
  toast: { success: (...args: unknown[]) => toastSuccess(...args), error: (...args: unknown[]) => toastError(...args), info: vi.fn() },
}));
vi.mock('../AdminAuthenticatedImage', () => ({
  AdminAuthenticatedImage: ({ alt }: { alt: string }) => <img alt={alt} />,
}));
vi.mock('../../../services/photos.service', () => ({
  photosService: {
    formatBytes: (n: number) => `${n} B`,
    deletePhotos: (...args: unknown[]) => deletePhotos(...args),
  },
}));
vi.mock('../PermissionGate', () => ({
  PermissionGate: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

const photo = (id: number) => ({
  id, filename: `p${id}.jpg`, path: '/x.jpg', url: '/x.jpg', thumbnail_url: '/t/x.jpg', type: 'photo',
  category_id: null, category_name: null, category_slug: null, size: 1, uploaded_at: '2026-01-01T00:00:00Z',
}) as unknown as AdminPhoto;

const onPhotosDeleted = vi.fn();
const renderGrid = (trashRetentionDays?: number) => render(
  <QueryClientProvider client={new QueryClient()}>
    <AdminPhotoGrid
      photos={[photo(1), photo(2)]}
      eventId={42}
      onPhotoClick={vi.fn()}
      onPhotosDeleted={onPhotosDeleted}
      trashRetentionDays={trashRetentionDays}
    />
  </QueryClientProvider>
);

async function deleteBoth() {
  const user = userEvent.setup();
  await user.click(screen.getByTestId('admin-photo-checkbox-1'));
  await user.click(screen.getByTestId('admin-photo-checkbox-2'));
  await user.click(screen.getByRole('button', { name: 'Delete Selected' }));
}

describe('AdminPhotoGrid delete with the photo trash', () => {
  beforeEach(() => {
    localStorage.clear();
    [deletePhotos, confirm, toastSuccess, toastError, onPhotosDeleted].forEach((fn) => fn.mockReset());
    confirm.mockResolvedValue(true);
  });

  it('says the photos go to the trash for the retention, and reports them moved', async () => {
    deletePhotos.mockResolvedValue({ trashed: 2, deleted: 0, failed: [], retention_days: 30 });
    renderGrid(30);
    await deleteBoth();

    await waitFor(() => expect(deletePhotos).toHaveBeenCalledWith(42, [1, 2]));
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({
      message: 'admin.photos.trash.confirmMany|2|admin.photos.trash.forDays|30',
    }));
    expect(toastSuccess).toHaveBeenCalledWith('admin.photos.trash.moved|2');
    expect(toastError).not.toHaveBeenCalled();
    expect(onPhotosDeleted).toHaveBeenCalled();
  });

  it('keeps "cannot be undone" when deleting is final', async () => {
    deletePhotos.mockResolvedValue({ trashed: 0, deleted: 2, failed: [] });
    renderGrid(0);
    await deleteBoth();

    await waitFor(() => expect(deletePhotos).toHaveBeenCalled());
    expect(confirm.mock.calls[0][0].message).toMatch(/cannot be undone/i);
    expect(toastSuccess).toHaveBeenCalledWith('admin.photos.trash.deleted|2');
  });

  it('a photo restored from the trash comes back usable, not dimmed as still being deleted', async () => {
    deletePhotos.mockResolvedValue({ trashed: 2, deleted: 0, failed: [], retention_days: 30 });
    const grid = (photos: AdminPhoto[]) => (
      <QueryClientProvider client={client}>
        <AdminPhotoGrid photos={photos} eventId={42} onPhotoClick={vi.fn()} onPhotosDeleted={onPhotosDeleted} trashRetentionDays={30} />
      </QueryClientProvider>
    );
    const client = new QueryClient();
    const { rerender } = render(grid([photo(1), photo(2)]));
    await deleteBoth();
    await waitFor(() => expect(onPhotosDeleted).toHaveBeenCalled());
    expect(screen.getByTestId('admin-photo-tile-1').className).toContain('opacity-50');

    // The refreshed list no longer has them; then photo 1 is restored.
    rerender(grid([]));
    rerender(grid([photo(1)]));
    expect(screen.getByTestId('admin-photo-tile-1').className).not.toContain('opacity-50');
  });

  it('reports a photo the server could not delete', async () => {
    deletePhotos.mockResolvedValue({ trashed: 1, deleted: 0, failed: [2], retention_days: 30 });
    renderGrid(30);
    await deleteBoth();

    await waitFor(() => expect(toastError).toHaveBeenCalledWith('admin.photos.trash.deleteFailed|1'));
    expect(toastSuccess).toHaveBeenCalledWith('admin.photos.trash.moved|1');
  });
});
