/**
 * Client-side pre-flight size guard on the admin uploader.
 *
 * The dropzone advertised the size limit but never checked it, unlike the
 * guest uploader (UserPhotoUpload) — so an admin streamed the entire
 * oversized file and only then got the backend's 400. Videos are checked
 * against their own cap (general_max_video_size_mb), which is why a clip
 * larger than the photo limit still gets through.
 *
 * Pins:
 *  - an oversized photo is dropped before selection, with a per-file toast
 *  - a video over the photo cap but under the video cap is accepted
 *  - a video over the video cap is dropped too
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';

import { PhotoUpload } from '../PhotoUpload';

vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next');
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string, opts?: any) => (opts && opts.name ? `${key}:${opts.name}:${opts.limit}` : key),
    }),
  };
});

const toastError = vi.fn();
vi.mock('react-toastify', () => ({
  toast: { warning: vi.fn(), info: vi.fn(), error: (...a: any[]) => toastError(...a), success: vi.fn() },
}));

const postMock = vi.fn();
vi.mock('../../../config/api', () => ({ api: { post: (...a: any[]) => postMock(...a), get: vi.fn() } }));

vi.mock('../../../hooks/useUploadProgress', () => ({
  useUploadProgress: () => ({
    snapshots: {},
    error: null,
    aggregate: { total: 0, pending: 0, processing: 0, complete: 0, failed: 0, failedPhotos: [], isComplete: false, isReady: true },
  }),
}));

vi.mock('../../../services/categories.service', () => ({
  categoriesService: { getEventCategories: vi.fn().mockResolvedValue([]) },
}));
vi.mock('../../../services/settings.service', () => ({
  settingsService: {
    getAllSettings: vi.fn().mockResolvedValue({
      general_allowed_file_types: 'jpg,jpeg,png,webp,mp4',
      general_max_file_size_mb: 1,
      general_max_video_size_mb: 5,
    }),
  },
}));

const renderWithClient = (ui: ReactElement) => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
};

const file = (name: string, type: string, mb: number) =>
  new File([new Uint8Array(Math.round(mb * 1024 * 1024))], name, { type });

const select = async (container: HTMLElement, user: ReturnType<typeof userEvent.setup>, f: File) => {
  const input = container.querySelector('input[type="file"]') as HTMLInputElement;
  await user.upload(input, f);
};

describe('PhotoUpload pre-flight size guard', () => {
  beforeEach(() => {
    toastError.mockReset();
    postMock.mockReset();
  });

  it('rejects a photo over the photo cap before it is selected', async () => {
    const user = userEvent.setup();
    const { container } = renderWithClient(<PhotoUpload eventId={1} />);
    // Wait for the settings query so the caps are not still at their defaults.
    await waitFor(() => expect(screen.getByText('upload.videoSizeLimit')).toBeInTheDocument());

    await select(container, user, file('huge.png', 'image/png', 2));

    expect(toastError).toHaveBeenCalledWith('upload.fileTooLarge:huge.png:1');
    expect(screen.queryByText('huge.png')).not.toBeInTheDocument();
    expect(postMock).not.toHaveBeenCalled();
  });

  it('accepts a video that exceeds the photo cap but fits the video cap', async () => {
    const user = userEvent.setup();
    const { container } = renderWithClient(<PhotoUpload eventId={1} />);
    await waitFor(() => expect(screen.getByText('upload.videoSizeLimit')).toBeInTheDocument());

    await select(container, user, file('clip.mp4', 'video/mp4', 2));

    expect(toastError).not.toHaveBeenCalled();
    expect(screen.getByText('clip.mp4')).toBeInTheDocument();
  });

  it('rejects a video over the video cap', async () => {
    const user = userEvent.setup();
    const { container } = renderWithClient(<PhotoUpload eventId={1} />);
    await waitFor(() => expect(screen.getByText('upload.videoSizeLimit')).toBeInTheDocument());

    await select(container, user, file('long.mp4', 'video/mp4', 6));

    expect(toastError).toHaveBeenCalledWith('upload.fileTooLarge:long.mp4:5');
    expect(screen.queryByText('long.mp4')).not.toBeInTheDocument();
  });
});
