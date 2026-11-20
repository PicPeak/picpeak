/**
 * The viewer pages on ArrowLeft / ArrowRight from the window. On a focused
 * highlight radio (issue 2549) the arrows must not page: the photo would
 * change under the focused control and its next press pin another photo.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { AdminPhotoViewer } from '../AdminPhotoViewer';
import { ConfirmDialogProvider } from '../../common/ConfirmDialog';
import { photosService, type AdminPhoto } from '../../../services/photos.service';

vi.mock('react-toastify', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('../../../hooks/usePermission', () => ({ usePermission: () => true }));
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
  photosService: {
    formatBytes: (n: number) => `${n} B`,
    deletePhoto: vi.fn(),
    setPhotoHighlight: vi.fn((_event: number, _photo: number, highlight: boolean | null) => Promise.resolve(highlight)),
  },
}));
vi.mock('../../../services/feedback.service', async () => {
  const actual = await vi.importActual<typeof import('../../../services/feedback.service')>('../../../services/feedback.service');
  return { ...actual, feedbackService: { getEventFeedback: vi.fn().mockResolvedValue({ feedback: [] }) } };
});

const photo = (id: number, filename: string) => ({
  id, filename, path: `/${filename}`, url: `/${filename}`, thumbnail_url: `/t/${filename}`,
  type: 'photo', category_id: null, category_slug: null, size: 1, uploaded_at: '2026-01-01T00:00:00Z',
}) as unknown as AdminPhoto;

describe('AdminPhotoViewer arrows on the highlight radios', () => {
  const renderViewer = () => render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ConfirmDialogProvider>
        <AdminPhotoViewer photos={[photo(1, 'a.jpg'), photo(2, 'b.jpg')]} initialIndex={0} eventId={1}
          onClose={vi.fn()} onPhotoDeleted={vi.fn()} categories={[]} />
      </ConfirmDialogProvider>
    </QueryClientProvider>,
  );

  it('do not page to another photo', () => {
    renderViewer();
    const radio = screen.getByRole('radio', { name: 'Always' });
    radio.focus();
    fireEvent.keyDown(radio, { key: 'ArrowRight' });
    expect(screen.queryAllByText('b.jpg')).toHaveLength(0);
    expect(screen.getAllByText('a.jpg').length).toBeGreaterThan(0);
  });

  it('move the pin like a radio group: one tab stop, arrows pick the next option and wrap', async () => {
    renderViewer();
    const auto = screen.getByRole('radio', { name: 'Automatic' });
    const always = screen.getByRole('radio', { name: 'Always' });
    const never = screen.getByRole('radio', { name: 'Never' });
    expect([auto.tabIndex, always.tabIndex, never.tabIndex]).toEqual([0, -1, -1]);

    auto.focus();
    fireEvent.keyDown(auto, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(always);
    await waitFor(() => expect(always).toHaveAttribute('aria-checked', 'true'));
    expect(photosService.setPhotoHighlight).toHaveBeenLastCalledWith(1, 1, true);
    expect([auto.tabIndex, always.tabIndex, never.tabIndex]).toEqual([-1, 0, -1]);

    fireEvent.keyDown(always, { key: 'ArrowLeft' });
    fireEvent.keyDown(auto, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(never);
    await waitFor(() => expect(never).toHaveAttribute('aria-checked', 'true'));
    expect(photosService.setPhotoHighlight).toHaveBeenLastCalledWith(1, 1, false);
    // Still the first photo: the viewer did not page.
    expect(screen.queryAllByText('b.jpg')).toHaveLength(0);
  });

  it('still page from anywhere else', () => {
    renderViewer();
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(screen.getAllByText('b.jpg').length).toBeGreaterThan(0);
  });
});
