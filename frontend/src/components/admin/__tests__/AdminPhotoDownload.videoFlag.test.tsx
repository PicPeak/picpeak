/**
 * Issue 2277: the admin grid and viewer tell downloadPhoto whether the item
 * is a video, so a video downloads directly and a photo keeps the fetch path.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement, ReactNode } from 'react';

import { AdminPhotoGrid } from '../AdminPhotoGrid';
import { AdminPhotoViewer } from '../AdminPhotoViewer';
import type { AdminPhoto } from '../../../services/photos.service';

const { downloadPhoto } = vi.hoisted(() => ({ downloadPhoto: vi.fn() }));

vi.mock('../../common', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../common')>()),
  useConfirm: () => async () => true,
}));
vi.mock('react-toastify', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('../../../hooks/usePermission', () => ({ usePermission: () => true }));
vi.mock('../PermissionGate', () => ({
  PermissionGate: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

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
vi.mock('../AdminAuthenticatedVideo', () => ({ AdminAuthenticatedVideo: () => null }));

vi.mock('../../../services/photos.service', () => ({
  photosService: { formatBytes: (n: number) => `${n} B`, downloadPhoto },
}));

vi.mock('../../../services/feedback.service', async () => {
  const actual = await vi.importActual<typeof import('../../../services/feedback.service')>('../../../services/feedback.service');
  return {
    ...actual,
    feedbackService: { getEventFeedback: vi.fn().mockResolvedValue({ feedback: [] }) },
  };
});

const base = {
  path: '/x', url: '/x', thumbnail_url: '/t/x', category_id: null, category_name: null,
  category_slug: null, size: 1, uploaded_at: '2026-01-01T00:00:00Z', visibility: 'visible',
  processing_status: 'complete',
};
const video = { ...base, id: 1, filename: 'clip.mp4', type: 'individual', media_type: 'video', mime_type: 'video/mp4' } as unknown as AdminPhoto;
const still = { ...base, id: 2, filename: 'a.jpg', type: 'individual', media_type: 'image', mime_type: 'image/jpeg' } as unknown as AdminPhoto;

const withQuery = (ui: ReactElement) => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>
);

beforeEach(() => {
  localStorage.clear();
  downloadPhoto.mockReset();
  downloadPhoto.mockResolvedValue(undefined);
});

describe('AdminPhotoGrid download (issue 2277)', () => {
  const clickTileDownload = async (id: number) => {
    const tile = screen.getByTestId(`admin-photo-tile-${id}`);
    const button = within(tile).getAllByRole('button').find((b) => b.querySelector('.lucide-download'));
    await userEvent.setup().click(button!);
  };

  it('flags a video tile and a photo tile', async () => {
    withQuery(<AdminPhotoGrid photos={[video, still]} eventId={42} onPhotoClick={vi.fn()} onPhotosDeleted={vi.fn()} />);

    await clickTileDownload(1);
    await waitFor(() => expect(downloadPhoto).toHaveBeenCalledWith(42, 1, 'clip.mp4', true));

    await clickTileDownload(2);
    await waitFor(() => expect(downloadPhoto).toHaveBeenCalledWith(42, 2, 'a.jpg', false));
  });
});

describe('AdminPhotoViewer download (issue 2277)', () => {
  const renderViewer = (item: AdminPhoto) => withQuery(
    <AdminPhotoViewer photos={[item]} initialIndex={0} eventId={42} onClose={vi.fn()} onPhotoDeleted={vi.fn()} categories={[]} />
  );

  it('flags a video', async () => {
    renderViewer(video);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Download' }));
    await waitFor(() => expect(downloadPhoto).toHaveBeenCalledWith(42, 1, 'clip.mp4', true));
  });

  it('leaves a photo on the fetch path', async () => {
    renderViewer(still);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Download' }));
    await waitFor(() => expect(downloadPhoto).toHaveBeenCalledWith(42, 2, 'a.jpg', false));
  });
});
