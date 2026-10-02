/**
 * Sort menus on the list view's column headers (issue 1739). The sort is
 * owned by the parent, together with the filter bar's select: a header only
 * reports the `sort` / `order` pair the admin picked and shows which one is
 * applied.
 */
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ComponentProps, ReactNode } from 'react';

import { AdminPhotoGrid } from '../AdminPhotoGrid';
import type { AdminPhoto } from '../../../services/photos.service';

vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next');
  return {
    ...actual,
    useTranslation: () => ({
      t: (_key: string, fallback?: any) =>
        typeof fallback === 'string' ? fallback : _key,
      i18n: { language: 'en' }
    })
  };
});

vi.mock('../AdminAuthenticatedImage', () => ({
  AdminAuthenticatedImage: ({ alt }: { alt: string }) => <img alt={alt} />
}));

vi.mock('../../../services/photos.service', () => ({
  photosService: {
    formatBytes: (n: number) => `${n} B`
  }
}));

vi.mock('../PermissionGate', () => ({
  PermissionGate: ({ children }: { children: ReactNode }) => <>{children}</>
}));

const photos: AdminPhoto[] = [
  {
    id: 1, filename: 'JH9.jpg', path: '/JH9.jpg', url: '/JH9.jpg', thumbnail_url: '/t/JH9.jpg',
    type: 'photo', category_id: null, category_name: null, category_slug: null,
    size: 1234, uploaded_at: '2026-01-01T00:00:00Z'
  }
];

const renderList = (props: Partial<ComponentProps<typeof AdminPhotoGrid>> = {}) => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <AdminPhotoGrid
        photos={photos}
        eventId={42}
        onPhotoClick={vi.fn()}
        onPhotosDeleted={vi.fn()}
        {...props}
      />
    </QueryClientProvider>
  );
};

describe('AdminPhotoGrid list sort headers', () => {
  beforeEach(() => {
    localStorage.setItem('picpeak.adminPhotos.view', 'list');
  });

  it('reports the picked sort and order to the parent', async () => {
    const user = userEvent.setup();
    const onSortChange = vi.fn();
    renderList({ sortBy: 'date', sortOrder: 'desc', onSortChange });

    await user.click(screen.getByRole('button', { name: 'Size' }));
    await user.click(within(screen.getByRole('menu', { name: 'Sort by Size' }))
      .getByRole('menuitemradio', { name: 'Largest first' }));
    expect(onSortChange).toHaveBeenLastCalledWith('size', 'desc');

    await user.click(screen.getByRole('button', { name: 'Photo' }));
    await user.click(screen.getByRole('menuitemradio', { name: 'A – Z' }));
    expect(onSortChange).toHaveBeenLastCalledWith('name', 'asc');
  });

  it('checks the applied option in the column that owns the sort, and no other', async () => {
    const user = userEvent.setup();
    renderList({ sortBy: 'name', sortOrder: 'asc', onSortChange: vi.fn() });

    await user.click(screen.getByRole('button', { name: 'Photo' }));
    expect(screen.getByRole('menuitemradio', { name: 'A – Z' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('menuitemradio', { name: 'Z – A' })).toHaveAttribute('aria-checked', 'false');

    await user.click(screen.getByRole('button', { name: 'Uploaded' }));
    for (const option of screen.getAllByRole('menuitemradio')) {
      expect(option).toHaveAttribute('aria-checked', 'false');
    }
  });

  it('offers a menu only on the columns the list can sort by', () => {
    renderList({ sortBy: 'date', sortOrder: 'desc', onSortChange: vi.fn() });
    const header = screen.getAllByRole('row')[0];
    expect(within(header).getAllByRole('button').map((b) => b.textContent))
      .toEqual(['Photo', 'Uploaded', 'Feedback', 'Size']);
  });

  it('keeps plain headers when the parent passes no sort handler', () => {
    renderList();
    const header = screen.getAllByRole('row')[0];
    expect(within(header).queryAllByRole('button')).toHaveLength(0);
    expect(within(header).getByText('Size')).toBeInTheDocument();
  });
});
