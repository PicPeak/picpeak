/**
 * The duplicates view (issue 2194): byte-identical photos of the gallery in
 * groups, each keeping the oldest upload unless the admin picks another, the
 * rest moved to the trash; the empty state, and no actions without
 * photos.delete or while the trash is off.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { PhotoDuplicatesModal, defaultKeepId } from '../PhotoDuplicatesModal';
import type { DuplicateGroup } from '../../../services/photos.service';

const getDuplicates = vi.fn();
const resolveDuplicates = vi.fn();
const toastSuccess = vi.fn();
const toastError = vi.fn();

vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next');
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string, options?: { count?: number; name?: string } | string) => {
        if (typeof options !== 'object') return key;
        if (options.name !== undefined) return `${key}:${options.name}`;
        return options.count !== undefined ? `${key}:${options.count}` : key;
      },
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
vi.mock('../AdminAuthenticatedImage', () => ({
  AdminAuthenticatedImage: ({ src }: { src: string }) => <img data-testid="dup-thumb" data-src={src} alt="" />,
}));
vi.mock('../../../services/photos.service', () => ({
  photosService: {
    getDuplicates: (...args: unknown[]) => getDuplicates(...args),
    resolveDuplicates: (...args: unknown[]) => resolveDuplicates(...args),
  },
}));

const photo = (id: number, uploaded_at: string, extra = {}) => ({
  id, filename: `IMG_${id}.jpg`, uploaded_at, size: 2048, media_type: 'image', source: 'admin' as const,
  moderation_status: null, thumbnail_url: `/admin/photos/7/thumbnail/${id}`, ...extra,
});
// The server sends a group oldest first; these are shuffled on purpose.
const groupA: DuplicateGroup = {
  content_sha256: 'aaa',
  photos: [photo(21, '2026-10-03T10:00:00.000Z'), photo(5, '2026-10-01T10:00:00.000Z', { source: 'guest' }), photo(9, '2026-10-02T10:00:00.000Z')],
};
const groupB: DuplicateGroup = {
  content_sha256: 'bbb',
  photos: [photo(31, '2026-09-01T10:00:00.000Z'), photo(32, '2026-09-05T10:00:00.000Z', { source: 'external' })],
};

const onTrashed = vi.fn();
const renderModal = (props: Partial<React.ComponentProps<typeof PhotoDuplicatesModal>> = {}) => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <PhotoDuplicatesModal eventId={7} open onClose={vi.fn()} canDelete trashRetentionDays={30} onTrashed={onTrashed} {...props} />
    </QueryClientProvider>
  );
};

describe('defaultKeepId', () => {
  it('is the oldest upload, the lower id on a tie, and a dated photo before an undated one', () => {
    expect(defaultKeepId(groupA)).toBe(5);
    expect(defaultKeepId({ content_sha256: 'x', photos: [photo(8, '2026-10-01T10:00:00.000Z'), photo(3, '2026-10-01T10:00:00.000Z')] })).toBe(3);
    expect(defaultKeepId({ content_sha256: 'x', photos: [photo(1, null as unknown as string), photo(2, '2026-10-01T10:00:00.000Z')] })).toBe(2);
  });
});

describe('PhotoDuplicatesModal', () => {
  beforeEach(() => {
    [getDuplicates, resolveDuplicates, toastSuccess, toastError, onTrashed].forEach((fn) => fn.mockReset());
    getDuplicates.mockResolvedValue({ groups: [groupA, groupB], total_groups: 2, total_photos: 5, limit: 20, offset: 0 });
    resolveDuplicates.mockResolvedValue({ trashed: 2, photo_ids: [21, 9], failed: [], retention_days: 30 });
  });

  it('shows each group with its photos, their date, size and source, and the byte-identical caveat', async () => {
    renderModal();
    const a = await screen.findByTestId('duplicates-group-aaa');
    expect(within(a).getByText('admin.photos.duplicates.copies:3')).toBeInTheDocument();
    for (const name of ['IMG_21.jpg', 'IMG_5.jpg', 'IMG_9.jpg']) expect(within(a).getByText(name)).toBeInTheDocument();
    expect(within(a).getAllByTestId('dup-thumb').map((img) => img.getAttribute('data-src')))
      .toEqual(['/admin/photos/7/thumbnail/21', '/admin/photos/7/thumbnail/5', '/admin/photos/7/thumbnail/9']);
    expect(within(a).getByText(/date\(2026-10-01\) · 2\.0 KB · admin\.photos\.duplicates\.sourceGuest/)).toBeInTheDocument();
    const b = screen.getByTestId('duplicates-group-bbb');
    expect(within(b).getByText(/admin\.photos\.duplicates\.sourceExternal/)).toBeInTheDocument();
    expect(screen.getByText('admin.photos.duplicates.intro')).toBeInTheDocument();
    expect(getDuplicates).toHaveBeenCalledWith(7, { limit: 20, offset: 0 });
  });

  it('marks the oldest upload of each group to keep, and keeps it unless another is picked', async () => {
    const user = userEvent.setup();
    renderModal();
    const a = await screen.findByTestId('duplicates-group-aaa');
    expect(within(a).getByRole('radio', { name: 'admin.photos.duplicates.keepThis:IMG_5.jpg' })).toBeChecked();
    expect(within(a).getByRole('radio', { name: 'admin.photos.duplicates.keepThis:IMG_21.jpg' })).not.toBeChecked();

    await user.click(within(a).getByTestId('duplicates-keep-aaa'));
    await waitFor(() => expect(resolveDuplicates).toHaveBeenCalledWith(7, [{ id: 5, content_sha256: 'aaa' }]));
    expect(toastSuccess).toHaveBeenCalledWith('admin.photos.duplicates.trashed:2');
    expect(onTrashed).toHaveBeenCalled();

    await user.click(within(a).getByRole('radio', { name: 'admin.photos.duplicates.keepThis:IMG_21.jpg' }));
    await user.click(within(a).getByTestId('duplicates-keep-aaa'));
    await waitFor(() => expect(resolveDuplicates).toHaveBeenLastCalledWith(7, [{ id: 21, content_sha256: 'aaa' }]));
  });

  it('keeps the marked photo in every group at once', async () => {
    const user = userEvent.setup();
    renderModal();
    await screen.findByTestId('duplicates-group-aaa');
    await user.click(screen.getByRole('radio', { name: 'admin.photos.duplicates.keepThis:IMG_32.jpg' }));
    await user.click(screen.getByTestId('duplicates-keep-all'));
    await waitFor(() => expect(resolveDuplicates).toHaveBeenCalledWith(7, [{ id: 5, content_sha256: 'aaa' }, { id: 32, content_sha256: 'bbb' }]));
  });

  it('says so when the gallery has no duplicates', async () => {
    getDuplicates.mockResolvedValue({ groups: [], total_groups: 0, total_photos: 0, limit: 20, offset: 0 });
    renderModal();
    expect(await screen.findByText('admin.photos.duplicates.empty')).toBeInTheDocument();
    expect(screen.queryByTestId('duplicates-groups')).not.toBeInTheDocument();
    expect(screen.queryByTestId('duplicates-keep-all')).not.toBeInTheDocument();
  });

  it('only lists the copies without photos.delete or while the trash is off', async () => {
    const { unmount } = renderModal({ canDelete: false });
    await screen.findByTestId('duplicates-group-aaa');
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
    expect(screen.queryByTestId('duplicates-keep-aaa')).not.toBeInTheDocument();
    unmount();

    renderModal({ trashRetentionDays: 0 });
    await screen.findByTestId('duplicates-group-aaa');
    expect(screen.getByText('admin.photos.duplicates.trashOff')).toBeInTheDocument();
    expect(screen.queryByTestId('duplicates-keep-all')).not.toBeInTheDocument();
  });
});
