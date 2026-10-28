/**
 * The list view's column chooser and Captured column (issue 1739).
 *
 *  - hiding a column drops its header and cells, and the choice survives a
 *    remount through localStorage
 *  - the Captured cell shows the camera clock the server sent, unshifted by
 *    the browser's zone, and stays empty when there is none
 *  - the Captured header sorts by capture_date
 */
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ComponentProps, ReactNode } from 'react';

import { AdminPhotoGrid } from '../AdminPhotoGrid';
import type { AdminPhoto } from '../../../services/photos.service';

vi.mock('../../common', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../common')>()),
  useConfirm: () => async () => true,
}));
vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next');
  return {
    ...actual,
    useTranslation: () => ({
      t: (_key: string, fallback?: any) => (typeof fallback === 'string' ? fallback : _key),
      i18n: { language: 'en' },
    }),
  };
});
vi.mock('../../../hooks/usePublicSettings', () => ({
  usePublicSettings: () => ({ data: { general_date_format: 'DD.MM.YYYY', general_time_format: '24h' } }),
}));
vi.mock('../AdminAuthenticatedImage', () => ({
  AdminAuthenticatedImage: ({ alt }: { alt: string }) => <img alt={alt} />,
}));
vi.mock('../../../services/photos.service', () => ({
  photosService: { formatBytes: (n: number) => `${n} B` },
}));
vi.mock('../PermissionGate', () => ({
  PermissionGate: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

const base = {
  path: '/x.jpg', url: '/x.jpg', thumbnail_url: '/t/x.jpg', type: 'photo',
  category_id: null, category_name: null, category_slug: null, size: 1234,
  uploaded_at: '2026-01-01T00:00:00Z',
};
const photos: AdminPhoto[] = [
  { ...base, id: 1, filename: 'dated.jpg', captured_at_local: '2026-06-03T23:45:10' },
  { ...base, id: 2, filename: 'undated.jpg', captured_at_local: null },
  { ...base, id: 3, filename: 'clip.mp4', media_type: 'video', captured_at_local: null, captured_at: '2026-06-03T11:15:42.000Z' },
] as AdminPhoto[];

const renderList = (props: Partial<ComponentProps<typeof AdminPhotoGrid>> = {}) => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <AdminPhotoGrid photos={photos} eventId={42} onPhotoClick={vi.fn()} onPhotosDeleted={vi.fn()} {...props} />
    </QueryClientProvider>,
  );
};
const headerTexts = () => within(screen.getAllByRole('row')[0])
  .getAllByRole('columnheader').map((h) => h.textContent).filter(Boolean);

describe('AdminPhotoGrid column chooser', () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('picpeak.adminPhotos.view', 'list');
  });

  it('shows every column by default, Captured included', () => {
    renderList();
    expect(headerTexts()).toEqual([
      'Photo', 'Category', 'admin.photos.columns.credit', 'Captured', 'Uploaded',
      'Engagement', 'Feedback', 'Size', 'Actions',
    ]);
  });

  it('hides a column and remembers it across a remount', async () => {
    const user = userEvent.setup();
    const { unmount } = renderList();
    await user.click(screen.getByRole('button', { name: 'Columns' }));
    const uploaded = screen.getByRole('menuitemcheckbox', { name: 'Uploaded' });
    expect(uploaded).toHaveAttribute('aria-checked', 'true');
    await user.click(uploaded);
    expect(uploaded).toHaveAttribute('aria-checked', 'false');
    // The menu stays open for the next toggle.
    expect(screen.getByRole('menu', { name: 'Columns' })).toBeInTheDocument();
    expect(headerTexts()).not.toContain('Uploaded');
    // Header and cells drop together, so the row keeps its alignment.
    const row = screen.getByTestId('admin-photo-row-1');
    expect(within(row).getAllByRole('cell')).toHaveLength(headerTexts().length + 1);

    unmount();
    renderList();
    expect(headerTexts()).not.toContain('Uploaded');
    expect(headerTexts()).toContain('Captured');
  });

  it('never offers the photo column or the actions', async () => {
    const user = userEvent.setup();
    renderList();
    await user.click(screen.getByRole('button', { name: 'Columns' }));
    const names = screen.getAllByRole('menuitemcheckbox').map((item) => item.textContent);
    expect(names).not.toContain('Photo');
    expect(names).not.toContain('Actions');
  });

  it('closes on Escape and returns focus to the trigger', async () => {
    const user = userEvent.setup();
    renderList();
    const trigger = screen.getByRole('button', { name: 'Columns' });
    await user.click(trigger);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu', { name: 'Columns' })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('is not shown in the grid view', () => {
    localStorage.setItem('picpeak.adminPhotos.view', 'grid');
    renderList();
    expect(screen.queryByRole('button', { name: 'Columns' })).not.toBeInTheDocument();
  });
});

describe('AdminPhotoGrid Captured column', () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('picpeak.adminPhotos.view', 'list');
  });

  it('shows the camera clock as sent and leaves an undated photo empty', () => {
    renderList();
    const capturedIndex = headerTexts().indexOf('Captured') + 1; // + the checkbox column
    const cellOf = (id: number) => within(screen.getByTestId(`admin-photo-row-${id}`)).getAllByRole('cell')[capturedIndex];
    // 23:45 stays 23:45 and the day stays the 3rd, whatever zone the test runs in.
    expect(cellOf(1)).toHaveTextContent('03.06.2026 23:45');
    expect(cellOf(2).textContent).toBe('');
    // A video's time is an instant: shown in the browser's zone.
    const local = new Date('2026-06-03T11:15:42.000Z');
    const hhmm = `${String(local.getHours()).padStart(2, '0')}:${String(local.getMinutes()).padStart(2, '0')}`;
    expect(cellOf(3).textContent).toContain(hhmm);
  });

  it('sorts by capture date', async () => {
    const user = userEvent.setup();
    const onSortChange = vi.fn();
    renderList({ sortBy: 'capture_date', sortOrder: 'asc', onSortChange });
    expect(screen.getByRole('columnheader', { name: 'Captured' })).toHaveAttribute('aria-sort', 'ascending');
    await user.click(screen.getByRole('button', { name: 'Captured' }));
    await user.click(screen.getByRole('menuitemradio', { name: 'Newest first' }));
    expect(onSortChange).toHaveBeenLastCalledWith('capture_date', 'desc');
  });
});
