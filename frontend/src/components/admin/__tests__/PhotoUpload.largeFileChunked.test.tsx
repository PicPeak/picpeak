/**
 * A single file larger than the batch cap goes through the chunked API.
 *
 * The batch logic (#509) splits a *selection* into POSTs under
 * general_max_upload_batch_size_mb, but a lone file above the cap cannot be
 * split that way and still went out as one multipart request — which is
 * exactly what a proxy with a request-size limit rejects. The chunked API
 * has existed all along and became reachable in #1377; nothing in the admin
 * UI called it.
 *
 * Pins:
 *  - a file above the cap is sent via photosService.uploadLargeFile, not POSTed
 *  - a file under the cap keeps the multipart path untouched
 *  - a mixed selection does both, and reports progress over both
 *  - with replace-by-name on, a large file is skipped into the report rather
 *    than uploaded as a second copy (the chunked complete has no replace flag)
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PhotoUpload } from '../PhotoUpload';
import { renderWithUploadSession as renderWithClient } from './uploadTestUtils';

vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next');
  return {
    ...actual,
    useTranslation: () => ({ t: (key: string) => key }),
  };
});

vi.mock('react-toastify', () => ({
  toast: { warning: vi.fn(), info: vi.fn(), error: vi.fn(), success: vi.fn() },
}));

const postMock = vi.fn();
vi.mock('../../../config/api', () => ({ api: { post: (...a: any[]) => postMock(...a), get: vi.fn() } }));

const uploadLargeFile = vi.fn();
vi.mock('../../../services/photos.service', async () => {
  const actual = await vi.importActual<typeof import('../../../services/photos.service')>(
    '../../../services/photos.service'
  );
  return {
    ...actual,
    photosService: {
      ...actual.photosService,
      shouldUseChunkedUpload: (size: number, threshold?: number) =>
        actual.photosService.shouldUseChunkedUpload(size, threshold),
      uploadLargeFile: (...a: any[]) => uploadLargeFile(...a),
    },
  };
});

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

// 2MB batch cap, generous per-file caps so the size guard does not interfere.
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


const file = (name: string, type: string, mb: number) =>
  new File([new Uint8Array(Math.round(mb * 1024 * 1024))], name, { type });

const selectAndUpload = async (container: HTMLElement, files: File[]) => {
  const user = userEvent.setup();
  await waitFor(() => expect(screen.getByText('upload.videoSizeLimit')).toBeInTheDocument());
  const input = container.querySelector('input[type="file"]') as HTMLInputElement;
  await user.upload(input, files);
  await user.click(screen.getByRole('button', { name: /common\.upload/ }));
};

describe('PhotoUpload large single files', () => {
  beforeEach(() => {
    postMock.mockReset();
    uploadLargeFile.mockReset();
    postMock.mockResolvedValue({ data: { successCount: 1, count: 1, upload_id: 'u1', errors: [] } });
    uploadLargeFile.mockResolvedValue({ success: true });
  });

  it('sends a file above the batch cap through the chunked API instead of one POST', async () => {
    const { container } = renderWithClient(<PhotoUpload eventId={7} />);
    const big = file('ceremony.mp4', 'video/mp4', 3);

    await selectAndUpload(container, [big]);

    await waitFor(() => expect(uploadLargeFile).toHaveBeenCalledTimes(1));
    const [eventId, sent, categoryId, onProgress] = uploadLargeFile.mock.calls[0];
    expect(eventId).toBe(7);
    expect(sent).toBe(big);
    expect(categoryId).toBeNull();
    expect(typeof onProgress).toBe('function');
    expect(postMock).not.toHaveBeenCalled();
  });

  it('keeps a file under the cap on the multipart path', async () => {
    const { container } = renderWithClient(<PhotoUpload eventId={7} />);

    await selectAndUpload(container, [file('portrait.jpg', 'image/jpeg', 1)]);

    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
    expect(postMock.mock.calls[0][0]).toBe('/admin/events/7/upload');
    expect(uploadLargeFile).not.toHaveBeenCalled();
  });

  it('splits a mixed selection between the two paths', async () => {
    const { container } = renderWithClient(<PhotoUpload eventId={7} />);
    const big = file('highlights.mp4', 'video/mp4', 3);
    const small1 = file('a.jpg', 'image/jpeg', 0.5);
    const small2 = file('b.jpg', 'image/jpeg', 0.5);

    await selectAndUpload(container, [small1, big, small2]);

    await waitFor(() => expect(uploadLargeFile).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
    expect(uploadLargeFile.mock.calls[0][1]).toBe(big);
    // Both small files fit one batch under the 2MB cap.
    const formData = postMock.mock.calls[0][1] as FormData;
    expect(formData.getAll('photos')).toHaveLength(2);
  });

  it('reports a chunked failure by filename and still uploads the rest', async () => {
    uploadLargeFile.mockRejectedValueOnce(new Error('Transfer failed'));
    const { container } = renderWithClient(<PhotoUpload eventId={7} />);

    await selectAndUpload(container, [file('broken.mp4', 'video/mp4', 3), file('ok.jpg', 'image/jpeg', 0.5)]);

    // The small file is not held hostage by the failed large one...
    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
    expect((postMock.mock.calls[0][1] as FormData).getAll('photos')).toHaveLength(1);
    // ...and the failure lands in the same report the multipart path uses.
    const report = await screen.findByTestId('upload-failure-report');
    expect(within(report).getByText('broken.mp4')).toBeInTheDocument();
    expect(within(report).getByText(/Transfer failed/)).toBeInTheDocument();
  });

  it('skips a large file into the report when replace-by-name is on', async () => {
    const user = userEvent.setup();
    const { container } = renderWithClient(<PhotoUpload eventId={7} />);
    await waitFor(() => expect(screen.getByText('upload.videoSizeLimit')).toBeInTheDocument());
    await user.click(screen.getByLabelText(/upload\.replaceByName/));

    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(input, [file('recut.mp4', 'video/mp4', 3), file('ok.jpg', 'image/jpeg', 0.5)]);
    await user.click(screen.getByRole('button', { name: /common\.upload/ }));

    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
    expect(uploadLargeFile).not.toHaveBeenCalled();
    const report = await screen.findByTestId('upload-failure-report');
    expect(within(report).getByText('recut.mp4')).toBeInTheDocument();
    expect(within(report).getByText(/largeFileReplaceSkipped/)).toBeInTheDocument();
  });
});
