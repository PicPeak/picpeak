/**
 * A session finishes only after every transfer has its response.
 *
 * The completion effect watches the processing aggregate, which covers the
 * upload ids received so far. With status polling routed (this PR) a fast
 * worker can finish batch 1's photos while batch 2's POST is still in
 * flight; the aggregate then reads complete and the session used to close
 * there — outcome toast, ids cleared, a second upload allowed — while the
 * loop was still adding to it.
 */
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PhotoUpload } from '../PhotoUpload';
import { renderWithUploadSession as renderWithClient } from './uploadTestUtils';

vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next');
  return {
    ...actual,
    useTranslation: () => ({ t: (key: string) => key }),
  };
});

const toastMock = vi.hoisted(() => ({
  warning: vi.fn(), info: vi.fn(), error: vi.fn(), success: vi.fn(),
}));
vi.mock('react-toastify', () => ({ toast: toastMock }));

const postMock = vi.fn();
vi.mock('../../../config/api', () => ({ api: { post: (...a: any[]) => postMock(...a), get: vi.fn() } }));

// The worker is "instantly done" for whatever ids exist: the shape that
// closed the session early.
vi.mock('../../../hooks/useUploadProgress', () => ({
  useUploadProgress: (ids: string[]) => ({
    snapshots: {},
    error: null,
    aggregate: ids && ids.length > 0
      ? { total: ids.length, pending: 0, processing: 0, complete: ids.length, failed: 0, failedPhotos: [], isComplete: true, isReady: true }
      : { total: 0, pending: 0, processing: 0, complete: 0, failed: 0, failedPhotos: [], isComplete: false, isReady: true },
  }),
}));

vi.mock('../../../services/categories.service', () => ({
  categoriesService: { getEventCategories: vi.fn().mockResolvedValue([]) },
}));
// 2MB batch cap: three 1MB files make two multipart requests.
vi.mock('../../../services/settings.service', () => ({
  settingsService: {
    getAllSettings: vi.fn().mockResolvedValue({
      general_allowed_file_types: 'jpg,jpeg,png,webp,mp4',
      general_max_file_size_mb: 100,
      general_max_video_size_mb: 100,
      general_max_upload_batch_size_mb: 2,
    }),
  },
}));

const file = (name: string) =>
  new File([new Uint8Array(1024 * 1024)], name, { type: 'image/jpeg' });

describe('PhotoUpload multi-batch completion', () => {
  beforeEach(() => postMock.mockReset());
  afterEach(() => vi.clearAllMocks());

  it('does not close the session while a later batch is still in flight', async () => {
    let releaseSecond!: (v: unknown) => void;
    postMock
      .mockResolvedValueOnce({ data: { count: 2, upload_id: 'u1', errors: [] } })
      .mockImplementationOnce(() => new Promise((resolve) => { releaseSecond = resolve; }));

    const user = userEvent.setup();
    const { container } = renderWithClient(<PhotoUpload eventId={1} />);
    await waitFor(() => expect(screen.getByText('upload.videoSizeLimit')).toBeInTheDocument());
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(input, [file('a.jpg'), file('b.jpg'), file('c.jpg')]);
    await user.click(screen.getByRole('button', { name: /common\.upload/ }));

    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(2));
    // Batch 1 is processed; batch 2 has no response yet. Not done.
    expect(toastMock.success).not.toHaveBeenCalled();

    releaseSecond({ data: { count: 1, upload_id: 'u2', errors: [] } });
    await waitFor(() => expect(toastMock.success).toHaveBeenCalledTimes(1));
  });
});
