/**
 * The admin picks a video's preview image (issue 2263): three frames taken
 * on request, the current one marked, a click keeps one, "Use default" goes
 * back to the default frame, and a failure says so with a retry.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { VideoPosterPicker, formatPosterOffset } from '../VideoPosterPicker';
import { AdminPhotoViewer } from '../AdminPhotoViewer';
import type { AdminPhoto } from '../../../services/photos.service';

const { getPosterCandidates, setPosterOffset, toastSuccess } = vi.hoisted(() => ({
  getPosterCandidates: vi.fn(),
  setPosterOffset: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock('../../common', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../common')>()),
  useConfirm: () => async () => true,
}));
vi.mock('react-toastify', () => ({ toast: { error: vi.fn(), success: toastSuccess } }));
let mockCanEdit = true;
vi.mock('../../../hooks/usePermission', () => ({ usePermission: () => mockCanEdit }));
vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next');
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string, options?: unknown) => (options && typeof options === 'object' && 'time' in options
        ? `${key} ${(options as { time: string }).time}`
        : key),
      i18n: { language: 'en' },
    }),
  };
});
vi.mock('../AdminAuthenticatedImage', () => ({
  AdminAuthenticatedImage: ({ alt }: { alt: string }) => <img alt={alt} />,
}));
vi.mock('../AdminAuthenticatedVideo', () => ({ AdminAuthenticatedVideo: () => null }));
vi.mock('../../../services/photos.service', () => ({
  photosService: { formatBytes: (n: number) => `${n} B`, getPosterCandidates, setPosterOffset },
}));
vi.mock('../../../services/feedback.service', async () => {
  const actual = await vi.importActual<typeof import('../../../services/feedback.service')>('../../../services/feedback.service');
  return { ...actual, feedbackService: { getEventFeedback: vi.fn().mockResolvedValue({ feedback: [] }) } };
});

const frames = (current: number | null) => ({
  duration: 10,
  poster_offset_seconds: current,
  default_offset_seconds: 1,
  candidates: [1, 5, 9].map((offset) => ({ offset_seconds: offset, image: `data:image/jpeg;base64,${offset}` })),
});

const newClient = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

function renderPicker(onChanged = vi.fn(), onClose = vi.fn()) {
  render(
    <QueryClientProvider client={newClient()}>
      <VideoPosterPicker open onClose={onClose} eventId={42} photoId={7} onChanged={onChanged} />
    </QueryClientProvider>
  );
  return { onChanged, onClose };
}

describe('VideoPosterPicker', () => {
  beforeEach(() => {
    getPosterCandidates.mockReset();
    setPosterOffset.mockReset();
    toastSuccess.mockReset();
  });

  it('shows the three frames and marks the current one', async () => {
    getPosterCandidates.mockResolvedValue(frames(5));
    renderPicker();

    const frame = await screen.findByRole('button', { name: 'admin.photos.poster.frameAt 0:05.0' });
    expect(getPosterCandidates).toHaveBeenCalledWith(42, 7);
    expect(screen.getAllByRole('button', { name: /admin\.photos\.poster\.frameAt/ })).toHaveLength(3);
    expect(frame).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'admin.photos.poster.frameAt 0:01.0' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByText('admin.photos.poster.isPicked 0:05.0')).toBeInTheDocument();
  });

  it('keeps a clicked frame and reports the change', async () => {
    getPosterCandidates.mockResolvedValue(frames(null));
    setPosterOffset.mockResolvedValue({ poster_offset_seconds: 9, thumbnail_url: '/t?v=p9' });
    const { onChanged, onClose } = renderPicker();

    expect(await screen.findByText('admin.photos.poster.isDefault')).toBeInTheDocument();
    // Already on the default frame: nothing to reset.
    expect(screen.getByRole('button', { name: 'admin.photos.poster.useDefault' })).toBeDisabled();
    await userEvent.setup().click(screen.getByRole('button', { name: 'admin.photos.poster.frameAt 0:09.0' }));

    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(setPosterOffset).toHaveBeenCalledWith(42, 7, 9);
    expect(onClose).toHaveBeenCalled();
  });

  it('goes back to the default frame', async () => {
    getPosterCandidates.mockResolvedValue(frames(5));
    setPosterOffset.mockResolvedValue({ poster_offset_seconds: null, thumbnail_url: '/t' });
    const { onChanged } = renderPicker();

    await userEvent.setup().click(await screen.findByRole('button', { name: 'admin.photos.poster.useDefault' }));

    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(setPosterOffset).toHaveBeenCalledWith(42, 7, null);
  });

  it('says why the frames could not be taken, and tries again', async () => {
    getPosterCandidates.mockRejectedValueOnce({ response: { data: { error: 'This video is too large to take preview frames from' } } });
    getPosterCandidates.mockResolvedValueOnce(frames(null));
    renderPicker();

    expect(await screen.findByText('This video is too large to take preview frames from')).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'admin.photos.poster.retry' }));
    expect(await screen.findAllByRole('button', { name: /admin\.photos\.poster\.frameAt/ })).toHaveLength(3);
  });

  it('keeps the picker open with the reason when the pick fails', async () => {
    getPosterCandidates.mockResolvedValue(frames(null));
    setPosterOffset.mockRejectedValue(new Error('network'));
    const { onChanged, onClose } = renderPicker();

    await userEvent.setup().click(await screen.findByRole('button', { name: 'admin.photos.poster.frameAt 0:05.0' }));

    expect(await screen.findByText('admin.photos.poster.saveError')).toBeInTheDocument();
    expect(onChanged).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('formats an offset the way a player shows a position', () => {
    expect(formatPosterOffset(0.25)).toBe('0:00.3');
    expect(formatPosterOffset(65.5)).toBe('1:05.5');
  });
});

describe('AdminPhotoViewer preview image', () => {
  const base = {
    id: 7, path: '/a', url: '/a', thumbnail_url: '/t/7', category_id: null, category_slug: null,
    size: 1, uploaded_at: '2026-01-01T00:00:00Z',
  };
  const video = { ...base, filename: 'clip.mp4', type: 'individual', media_type: 'video', mime_type: 'video/mp4', poster_offset_seconds: null } as unknown as AdminPhoto;
  const image = { ...base, filename: 'a.jpg', type: 'photo', media_type: 'photo' } as unknown as AdminPhoto;

  const renderViewer = (photo: AdminPhoto, client = newClient()) => render(
    <QueryClientProvider client={client}>
      <AdminPhotoViewer photos={[photo]} initialIndex={0} eventId={42} onClose={vi.fn()} onPhotoDeleted={vi.fn()} categories={[]} />
    </QueryClientProvider>
  );

  beforeEach(() => { mockCanEdit = true; });

  it('is offered for a video only', () => {
    const { unmount } = renderViewer(image);
    expect(screen.queryByText('admin.photos.poster.choose')).not.toBeInTheDocument();
    unmount();
    renderViewer(video);
    expect(screen.getByText('admin.photos.poster.isDefault')).toBeInTheDocument();
    expect(screen.getByText('admin.photos.poster.choose')).toBeInTheDocument();
  });

  it('shows a reader without photos.edit the frame, not the picker', () => {
    mockCanEdit = false;
    renderViewer(video);
    expect(screen.getByText('admin.photos.poster.isDefault')).toBeInTheDocument();
    expect(screen.queryByText('admin.photos.poster.choose')).not.toBeInTheDocument();
  });

  it('refreshes the photo list after a pick, so the tile shows the new poster', async () => {
    getPosterCandidates.mockResolvedValue(frames(null));
    setPosterOffset.mockResolvedValue({ poster_offset_seconds: 5, thumbnail_url: '/t/7?v=p5' });
    const client = newClient();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const user = userEvent.setup();
    renderViewer(video, client);

    await user.click(screen.getByText('admin.photos.poster.choose'));
    await user.click(await screen.findByRole('button', { name: 'admin.photos.poster.frameAt 0:05.0' }));

    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ['admin-event-photos'] }));
    expect(toastSuccess).toHaveBeenCalledWith('admin.photos.poster.saved');
  });
});
