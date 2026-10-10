/**
 * Coverage for the Grid / List layout toggle on the admin event
 * Photos tab. The toggle swaps the rendered layout (grid tiles vs.
 * list rows) and persists the choice to localStorage via
 * utils/photoViewPrefs, so it survives a remount. These tests pin both
 * behaviours so a refactor can't silently drop the list view or its
 * persistence.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement, ReactNode } from 'react';

import { AdminPhotoGrid } from '../AdminPhotoGrid';
import type { AdminPhoto } from '../../../services/photos.service';

// Delete and archive ask through the app's confirm dialog; these cases never
// reach one, so a provider-free stub keeps the render self-contained.
vi.mock('../../common', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../common')>()),
  useConfirm: () => async () => true,
}));
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

// AdminAuthenticatedImage fetches an authenticated blob; stub it to a
// plain img so the grid renders without a network layer.
vi.mock('../AdminAuthenticatedImage', () => ({
  AdminAuthenticatedImage: ({ alt }: { alt: string }) => <img alt={alt} />
}));

vi.mock('../../../services/photos.service', () => ({
  photosService: {
    formatBytes: (n: number) => `${n} B`
  }
}));

// AdminPhotoGrid now wraps its action buttons in PermissionGate (which needs a
// PermissionsProvider). This test is about the layout toggle, not gating, so
// stub the gate to a passthrough that always renders its children.
vi.mock('../PermissionGate', () => ({
  PermissionGate: ({ children }: { children: ReactNode }) => <>{children}</>
}));

const renderWithQueryClient = (ui: ReactElement) => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } }
  });
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
};

const photos: AdminPhoto[] = [
  {
    id: 1, filename: 'a.jpg', path: '/a.jpg', url: '/a.jpg', thumbnail_url: '/t/a.jpg',
    type: 'photo', category_id: null, category_name: null, category_slug: null,
    size: 1234, uploaded_at: '2026-01-01T00:00:00Z'
  },
  {
    id: 2, filename: 'b.jpg', path: '/b.jpg', url: '/b.jpg', thumbnail_url: '/t/b.jpg',
    type: 'photo', category_id: null, category_name: null, category_slug: null,
    size: 5678, uploaded_at: '2026-01-02T00:00:00Z'
  }
];

const renderGrid = () =>
  renderWithQueryClient(
    <AdminPhotoGrid
      photos={photos}
      eventId={42}
      onPhotoClick={vi.fn()}
      onPhotosDeleted={vi.fn()}
    />
  );

describe('AdminPhotoGrid layout toggle', () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    localStorage.clear();
  });

  it('renders grid tiles by default', () => {
    renderGrid();
    expect(screen.getByTestId('admin-photo-tile-1')).toBeInTheDocument();
    expect(screen.queryByTestId('admin-photo-row-1')).not.toBeInTheDocument();
  });

  it('does not write to localStorage on mount (only on user toggle)', () => {
    renderGrid();
    // Opening the tab must not persist the value it just read.
    expect(localStorage.getItem('picpeak.adminPhotos.view')).toBeNull();
  });

  it('switches to list rows when the List toggle is clicked', async () => {
    const user = userEvent.setup();
    renderGrid();

    await user.click(screen.getByRole('radio', { name: /list view/i }));

    expect(screen.getByTestId('admin-photo-row-1')).toBeInTheDocument();
    expect(screen.getByTestId('admin-photo-row-2')).toBeInTheDocument();
    expect(screen.queryByTestId('admin-photo-tile-1')).not.toBeInTheDocument();
  });

  it('persists the chosen layout across a remount', async () => {
    const user = userEvent.setup();
    const { unmount } = renderGrid();

    await user.click(screen.getByRole('radio', { name: /list view/i }));
    expect(localStorage.getItem('picpeak.adminPhotos.view')).toBe('list');
    unmount();

    renderGrid();
    expect(screen.getByTestId('admin-photo-row-1')).toBeInTheDocument();
    expect(screen.queryByTestId('admin-photo-tile-1')).not.toBeInTheDocument();
  });
});
