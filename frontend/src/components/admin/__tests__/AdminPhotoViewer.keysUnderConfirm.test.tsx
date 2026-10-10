/**
 * The photo viewer listens for keys on the window (Escape, arrows, 1-9). While
 * its "Delete photo?" confirm is open, those keys belong to the confirm:
 * Escape cancels the confirm and leaves the viewer open, and the arrows do not
 * page to another photo behind a dialog that names the first one.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { AdminPhotoViewer } from '../AdminPhotoViewer';
import { ConfirmDialogProvider } from '../../common/ConfirmDialog';
import type { AdminPhoto } from '../../../services/photos.service';

vi.mock('react-toastify', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
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
vi.mock('../AdminAuthenticatedVideo', () => ({ AdminAuthenticatedVideo: () => null }));
vi.mock('../../../services/photos.service', () => ({
  photosService: { formatBytes: (n: number) => `${n} B`, deletePhoto: vi.fn() },
}));
vi.mock('../../../services/feedback.service', async () => {
  const actual = await vi.importActual<typeof import('../../../services/feedback.service')>('../../../services/feedback.service');
  return { ...actual, feedbackService: { getEventFeedback: vi.fn().mockResolvedValue({ feedback: [] }) } };
});

const photo = (id: number, filename: string) => ({
  id, filename, path: `/${filename}`, url: `/${filename}`, thumbnail_url: `/t/${filename}`,
  type: 'photo', category_id: null, category_slug: null, size: 1, uploaded_at: '2026-01-01T00:00:00Z',
}) as unknown as AdminPhoto;

describe('AdminPhotoViewer keys under the delete confirm', () => {
  it('Escape cancels the confirm and the arrows do not page behind it', async () => {
    const onClose = vi.fn();
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ConfirmDialogProvider>
          <AdminPhotoViewer photos={[photo(1, 'a.jpg'), photo(2, 'b.jpg')]} initialIndex={0} eventId={1}
            onClose={onClose} onPhotoDeleted={vi.fn()} categories={[]} />
        </ConfirmDialogProvider>
      </QueryClientProvider>,
    );
    expect(screen.getAllByText('a.jpg').length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('button', { name: /delete/i }));
    await screen.findByText(/This cannot be undone/);

    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(screen.queryAllByText('b.jpg')).toHaveLength(0);

    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByText(/This cannot be undone/)).not.toBeInTheDocument());
    expect(onClose).not.toHaveBeenCalled();

    // With the confirm gone, the viewer's keys work again.
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
