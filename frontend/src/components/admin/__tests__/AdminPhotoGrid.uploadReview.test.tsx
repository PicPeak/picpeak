/**
 * Review of team members' uploads (issue 743) on the admin Photos tab: a
 * photo under review carries a "Pending review" / "Rejected" badge with the
 * uploader, instead of the plain "Hidden" one, and only the gallery's owner
 * (canModerate) gets Approve / Reject for a selection holding such photos.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement, ReactNode } from 'react';

import { AdminPhotoGrid } from '../AdminPhotoGrid';
import type { AdminPhoto } from '../../../services/photos.service';

const moderatePhotos = vi.fn();

vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next');
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string, fallback?: unknown) => (typeof fallback === 'string' ? fallback : key),
      i18n: { language: 'en' },
    }),
  };
});

vi.mock('../AdminAuthenticatedImage', () => ({
  AdminAuthenticatedImage: ({ alt }: { alt: string }) => <img alt={alt} />,
}));

vi.mock('../../../services/photos.service', () => ({
  photosService: {
    formatBytes: (n: number) => `${n} B`,
    moderatePhotos: (...args: unknown[]) => moderatePhotos(...args),
  },
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
  type: 'photo', category_id: null, category_name: null, category_slug: null,
  size: 1234, uploaded_at: '2026-01-01T00:00:00Z', visibility: 'hidden',
};

const photos = [
  { ...basePhoto, id: 1, filename: 'pending.jpg', moderation_status: 'pending', uploaded_by_admin: { id: 7, username: 'anna' } },
  { ...basePhoto, id: 2, filename: 'rejected.jpg', moderation_status: 'rejected', uploaded_by_admin: { id: 7, username: 'anna' } },
  { ...basePhoto, id: 3, filename: 'hidden.jpg', moderation_status: null },
] as unknown as AdminPhoto[];

const renderGrid = (canModerate: boolean) => renderWithQueryClient(
  <AdminPhotoGrid
    photos={photos}
    eventId={42}
    onPhotoClick={vi.fn()}
    onPhotosDeleted={vi.fn()}
    canModerate={canModerate}
  />
);

describe('AdminPhotoGrid upload review', () => {
  beforeEach(() => { localStorage.clear(); moderatePhotos.mockReset(); });
  afterEach(() => localStorage.clear());

  it('badges photos under review with their status and uploader, and keeps "Hidden" for the rest', () => {
    renderGrid(false);
    expect(screen.getByTestId('admin-photo-review-badge-1')).toHaveTextContent('Pending review');
    expect(screen.getByTestId('admin-photo-review-badge-1')).toHaveTextContent('anna');
    expect(screen.getByTestId('admin-photo-review-badge-2')).toHaveTextContent('Rejected');
    expect(screen.queryByTestId('admin-photo-hidden-badge-1')).toBeNull();
    expect(screen.getByTestId('admin-photo-hidden-badge-3')).toBeInTheDocument();
  });

  it('offers Approve / Reject to the owner only, and approves just the photos under review', async () => {
    const user = userEvent.setup();
    const member = renderGrid(false);
    await user.click(screen.getByTestId('admin-photo-checkbox-1'));
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    member.unmount();

    moderatePhotos.mockResolvedValue({ updated: 1, moderation: { pending: 0, rejected: 1 } });
    renderGrid(true);
    await user.click(screen.getByTestId('admin-photo-checkbox-1'));
    await user.click(screen.getByTestId('admin-photo-checkbox-3'));
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    expect(moderatePhotos).toHaveBeenCalledWith(42, [1], 'approve');
  });
});
