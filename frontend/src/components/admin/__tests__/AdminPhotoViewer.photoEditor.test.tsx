/**
 * The photo editor's entry in the admin viewer (issue 2619): offered for an
 * image to an admin with photos.edit while the photoEditor flag is on, not
 * for a video; E opens it; an edited photo downloads as the original or as
 * the edit.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { AdminPhotoViewer } from '../AdminPhotoViewer';
import type { AdminPhoto } from '../../../services/photos.service';

const { flags, canEdit, downloadPhoto } = vi.hoisted(() => ({
  flags: { photoEditor: true },
  canEdit: { value: true },
  downloadPhoto: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../contexts/FeatureFlagsContext', () => ({ useFeatureEnabled: (key: 'photoEditor') => flags[key] }));
vi.mock('../../../hooks/usePermission', () => ({ usePermission: () => canEdit.value }));
vi.mock('../../common', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../common')>()),
  useConfirm: () => async () => true,
}));
vi.mock('react-toastify', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next');
  return {
    ...actual,
    useTranslation: () => ({ t: (key: string, fallback?: any) => (typeof fallback === 'string' ? fallback : key), i18n: { language: 'en' } }),
  };
});
vi.mock('../AdminAuthenticatedImage', () => ({ AdminAuthenticatedImage: ({ alt }: { alt: string }) => <img alt={alt} /> }));
vi.mock('../AdminAuthenticatedVideo', () => ({ AdminAuthenticatedVideo: () => null }));
vi.mock('../../../services/photos.service', () => ({ photosService: { formatBytes: (n: number) => `${n} B`, downloadPhoto } }));
vi.mock('../../../services/feedback.service', async () => {
  const actual = await vi.importActual<typeof import('../../../services/feedback.service')>('../../../services/feedback.service');
  return { ...actual, feedbackService: { getEventFeedback: vi.fn().mockResolvedValue({ feedback: [] }) } };
});
// The editor chunk itself is not under test here: a marker stands in.
vi.mock('../../../features/photo-editor/PhotoEditor', () => ({ default: () => <div role="dialog" aria-label="photo editor stub" /> }));

const image = {
  id: 7, filename: 'a.jpg', url: '/a.jpg', thumbnail_url: '/t/a.jpg', type: 'photo', media_type: 'image',
  category_id: null, size: 1, uploaded_at: '2026-01-01T00:00:00Z',
} as unknown as AdminPhoto;
const video = { ...image, id: 8, filename: 'b.mp4', media_type: 'video', mime_type: 'video/mp4' } as unknown as AdminPhoto;

const renderViewer = (photo: AdminPhoto) => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <AdminPhotoViewer photos={[photo]} initialIndex={0} eventId={42} onClose={vi.fn()} onPhotoDeleted={vi.fn()} categories={[]} />
  </QueryClientProvider>,
);

beforeEach(() => {
  flags.photoEditor = true;
  canEdit.value = true;
  downloadPhoto.mockClear();
});

describe('AdminPhotoViewer photo editor entry', () => {
  it('opens the editor from the button and from E', async () => {
    const user = userEvent.setup();
    const { unmount } = renderViewer(image);
    await user.click(screen.getByRole('button', { name: 'Edit photo' }));
    expect(await screen.findByRole('dialog', { name: 'photo editor stub' })).toBeInTheDocument();
    unmount();
    renderViewer(image);
    await user.keyboard('e');
    expect(await screen.findByRole('dialog', { name: 'photo editor stub' })).toBeInTheDocument();
  });

  it('is not offered with the flag off, without photos.edit, or for a video', () => {
    flags.photoEditor = false;
    const first = renderViewer(image);
    expect(screen.queryByRole('button', { name: 'Edit photo' })).toBeNull();
    first.unmount();
    flags.photoEditor = true;
    canEdit.value = false;
    const second = renderViewer(image);
    expect(screen.queryByRole('button', { name: 'Edit photo' })).toBeNull();
    second.unmount();
    canEdit.value = true;
    renderViewer(video);
    expect(screen.queryByRole('button', { name: 'Edit photo' })).toBeNull();
  });

  it('downloads an edited photo as the original or as the edit', async () => {
    const user = userEvent.setup();
    renderViewer({ ...image, edited: true } as AdminPhoto);
    await user.click(screen.getByRole('button', { name: 'Original' }));
    await user.click(screen.getByRole('button', { name: 'Edited' }));
    await waitFor(() => expect(downloadPhoto).toHaveBeenCalledTimes(2));
    expect(downloadPhoto.mock.calls[0]).toHaveLength(4);
    expect(downloadPhoto.mock.calls[1][4]).toEqual({ edited: true });
  });
});
