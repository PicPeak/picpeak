/**
 * A photo whose file is gone from the external folder (issue 2121) is out of
 * every gallery view but kept on the admin Photos tab, so the admin can
 * delete it or wait for the file. It has to say so on the tile and the row,
 * apart from (and next to) a visibility the admin chose.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement, ReactNode } from 'react';

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
vi.mock('../AdminAuthenticatedImage', () => ({
  AdminAuthenticatedImage: ({ alt }: { alt: string }) => <img alt={alt} />,
}));
vi.mock('../../../services/photos.service', () => ({
  photosService: { formatBytes: (n: number) => `${n} B` },
}));
vi.mock('../PermissionGate', () => ({
  PermissionGate: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

const renderWithQueryClient = (ui: ReactElement) => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
};

const basePhoto = {
  path: '/x.jpg', url: '/x.jpg', thumbnail_url: '/t/x.jpg',
  type: 'photo', category_id: null, category_slug: null, category_name: 'Ceremony',
  size: 1234, uploaded_at: '2026-01-01T00:00:00Z', visibility: 'visible',
};

const photos = [
  { ...basePhoto, id: 1, filename: 'gone.jpg', unavailable_reason: 'source_missing' },
  { ...basePhoto, id: 2, filename: 'gone-hidden.jpg', unavailable_reason: 'source_missing', visibility: 'hidden' },
  { ...basePhoto, id: 3, filename: 'here.jpg', unavailable_reason: null },
] as unknown as AdminPhoto[];

const renderGrid = () => renderWithQueryClient(
  <AdminPhotoGrid photos={photos} eventId={42} onPhotoClick={vi.fn()} onPhotosDeleted={vi.fn()} />
);

describe('AdminPhotoGrid missing-file indicator', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('badges the tiles whose file is gone, with an explanation', () => {
    renderGrid();
    const badge = screen.getByTestId('admin-photo-missing-badge-1');
    expect(badge).toHaveTextContent('File missing');
    expect(badge.firstElementChild).toHaveAttribute('title', expect.stringContaining('no longer in the external folder'));
    expect(screen.queryByTestId('admin-photo-missing-badge-3')).not.toBeInTheDocument();
    expect(screen.queryByTestId('admin-photo-hidden-badge-1')).not.toBeInTheDocument();
  });

  it('keeps the hidden badge of a photo the admin hid next to it', () => {
    renderGrid();
    expect(screen.getByTestId('admin-photo-missing-badge-2')).toBeInTheDocument();
    expect(screen.getByTestId('admin-photo-hidden-badge-2')).toBeInTheDocument();
  });

  it('drops the category badge a row under it', () => {
    renderGrid();
    const category = Array.from(screen.getByTestId('admin-photo-tile-1').querySelectorAll('div')).find(
      (node) => node.textContent === 'Ceremony' && node.className.includes('absolute')
    );
    expect(category?.className).toContain('top-9');
  });

  it('badges the row in list view too', async () => {
    const user = userEvent.setup();
    renderGrid();
    await user.click(screen.getByRole('radio', { name: /list view/i }));
    expect(screen.getByTestId('admin-photo-row-1')).toHaveTextContent('File missing');
    expect(screen.getByTestId('admin-photo-row-3')).not.toHaveTextContent('File missing');
  });
});
