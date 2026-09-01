/**
 * A photo hidden from client access has to be distinguishable from a visible
 * one on the admin Photos tab — otherwise the admin cannot tell what guests
 * actually see (QA warning). Both layouts carry the same badge vocabulary:
 * EyeOff icon + "Hidden" label + an explanatory tooltip.
 *
 * The badge markup already existed; what was missing was `visibility` in the
 * list route's response (guarded separately in the backend suite). These
 * tests pin the UI half of that contract.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement, ReactNode } from 'react';

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

const renderWithQueryClient = (ui: ReactElement) => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } }
  });
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
};

const basePhoto = {
  path: '/x.jpg', url: '/x.jpg', thumbnail_url: '/t/x.jpg',
  type: 'photo', category_id: null, category_slug: null,
  size: 1234, uploaded_at: '2026-01-01T00:00:00Z'
};

const photos = [
  { ...basePhoto, id: 1, filename: 'hidden.jpg', category_name: 'Ceremony', visibility: 'hidden' },
  { ...basePhoto, id: 2, filename: 'visible.jpg', category_name: 'Ceremony', visibility: 'visible' }
] as unknown as AdminPhoto[];

const renderGrid = () =>
  renderWithQueryClient(
    <AdminPhotoGrid
      photos={photos}
      eventId={42}
      onPhotoClick={vi.fn()}
      onPhotosDeleted={vi.fn()}
    />
  );

describe('AdminPhotoGrid hidden-photo indicator', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('badges only the hidden tile in grid view', () => {
    renderGrid();

    expect(screen.getByTestId('admin-photo-hidden-badge-1')).toBeInTheDocument();
    expect(screen.queryByTestId('admin-photo-hidden-badge-2')).not.toBeInTheDocument();
  });

  it('carries a tooltip explaining what "hidden" means', () => {
    renderGrid();

    const badge = screen.getByTestId('admin-photo-hidden-badge-1').firstElementChild;
    expect(badge).toHaveAttribute('title', expect.stringContaining('Hidden from guests'));
  });

  it('does not let the category badge cover the hidden badge', () => {
    renderGrid();

    // Both live in the tile's top-left corner; the category badge drops a
    // row while the hidden badge is showing.
    const tile = screen.getByTestId('admin-photo-tile-1');
    const category = Array.from(tile.querySelectorAll('div')).find(
      (node) => node.textContent === 'Ceremony' && node.className.includes('absolute')
    );
    expect(category?.className).toContain('top-9');

    const visibleTile = screen.getByTestId('admin-photo-tile-2');
    const visibleCategory = Array.from(visibleTile.querySelectorAll('div')).find(
      (node) => node.textContent === 'Ceremony' && node.className.includes('absolute')
    );
    expect(visibleCategory?.className).toContain('top-2');
  });

  it('badges the hidden photo in list view too', async () => {
    const user = userEvent.setup();
    renderGrid();

    await user.click(screen.getByRole('radio', { name: /list view/i }));

    const hiddenRow = screen.getByTestId('admin-photo-row-1');
    const visibleRow = screen.getByTestId('admin-photo-row-2');
    expect(hiddenRow).toHaveTextContent('Hidden');
    expect(visibleRow).not.toHaveTextContent('Hidden');
  });
});
