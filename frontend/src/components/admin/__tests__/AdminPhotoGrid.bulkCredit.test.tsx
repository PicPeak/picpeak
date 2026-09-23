/**
 * Bulk credit dialog on the admin photo grid (issue 1561 review).
 *
 *  - a name the server refuses (e.g. "<>", nothing left once sanitised)
 *    shows the server's reason, not a bare "error"
 *  - the dialog forgets the last name once it closes, so the next
 *    selection does not start with it
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { AdminPhotoGrid } from '../AdminPhotoGrid';
import type { AdminPhoto } from '../../../services/photos.service';

const { bulkUpdatePhotos, toastError, toastSuccess } = vi.hoisted(() => ({
  bulkUpdatePhotos: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock('react-toastify', () => ({ toast: { error: toastError, success: toastSuccess } }));

vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next');
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string, fallback?: any) => (typeof fallback === 'string' ? fallback : key),
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
    bulkUpdatePhotos,
  },
}));

vi.mock('../PermissionGate', () => ({
  PermissionGate: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

const photos = [
  {
    id: 1, filename: 'a.jpg', path: '/a.jpg', url: '/a.jpg', thumbnail_url: '/t/a.jpg',
    type: 'photo', category_id: null, category_slug: null, size: 1, uploaded_at: '2026-01-01T00:00:00Z',
  },
] as unknown as AdminPhoto[];

const renderGrid = () => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <AdminPhotoGrid photos={photos} eventId={42} onPhotoClick={vi.fn()} onPhotosDeleted={vi.fn()} />
  </QueryClientProvider>
);

async function openCreditDialog(user: ReturnType<typeof userEvent.setup>) {
  if (!screen.queryByText('admin.photos.credit.bulkAction')) {
    await user.click(screen.getByText('Select Photos'));
    await user.click(screen.getByText('Select All'));
  }
  await user.click(screen.getByText('admin.photos.credit.bulkAction'));
  return screen.getByRole('textbox') as HTMLInputElement;
}

describe('AdminPhotoGrid bulk credit', () => {
  beforeEach(() => {
    bulkUpdatePhotos.mockReset();
    toastError.mockReset();
    toastSuccess.mockReset();
  });

  it('shows the server reason when a name is refused', async () => {
    bulkUpdatePhotos.mockRejectedValue({ response: { data: { error: 'This name has no characters that can be shown.' } } });
    const user = userEvent.setup();
    renderGrid();
    const input = await openCreditDialog(user);
    await user.type(input, '<>');
    await user.click(screen.getByText('admin.photos.credit.save'));
    await waitFor(() => expect(toastError).toHaveBeenCalledWith('This name has no characters that can be shown.'));
    // Still open, with the name to fix.
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('<>');
  });

  it('falls back to the generic message without a server reason', async () => {
    bulkUpdatePhotos.mockRejectedValue(new Error('Network Error'));
    const user = userEvent.setup();
    renderGrid();
    await user.type(await openCreditDialog(user), 'Anna');
    await user.click(screen.getByText('admin.photos.credit.save'));
    await waitFor(() => expect(toastError).toHaveBeenCalledWith('common.error'));
  });

  it('starts empty the next time after a saved name', async () => {
    bulkUpdatePhotos.mockResolvedValue({});
    const user = userEvent.setup();
    renderGrid();
    await user.type(await openCreditDialog(user), 'Anna');
    await user.click(screen.getByText('admin.photos.credit.save'));
    await waitFor(() => expect(screen.queryByRole('textbox')).toBeNull());
    expect(bulkUpdatePhotos).toHaveBeenCalledWith(42, [1], { credit_name: 'Anna' });

    const again = await openCreditDialog(user);
    expect(again.value).toBe('');
  });
});
