/**
 * Duplicates in the admin uploader (issue 1733, C2).
 *
 * The server does not store a file whose bytes the gallery already holds and
 * names it under `duplicates` (multipart) or refuses the chunked complete
 * with DUPLICATE_PHOTO. These tests pin that the bar lists such files apart
 * from the failures, and that "upload anyway" sends exactly those files again
 * without asking for detection, per file and for all.
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
    useTranslation: () => ({
      t: (key: string, fallback?: any, options?: any) => (typeof fallback === 'string'
        ? fallback.replace(/\{\{(\w+)\}\}/g, (_m, name) => String(options?.[name] ?? ''))
        : key),
    }),
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
  useUploadProgress: (ids: string[]) => ({
    snapshots: {},
    error: null,
    aggregate: {
      total: ids.length, pending: 0, processing: 0, complete: ids.length, failed: 0, failedPhotos: [],
      isComplete: ids.length > 0, isReady: true,
    },
  }),
}));

vi.mock('../../../services/categories.service', () => ({
  categoriesService: { getEventCategories: vi.fn().mockResolvedValue([]) },
}));
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

const small = (name: string) => new File([new Uint8Array([1, 2, 3])], name, { type: 'image/jpeg' });

const selectAndUpload = async (container: HTMLElement, files: File[]) => {
  const user = userEvent.setup();
  await waitFor(() => expect(screen.getByText('Videos: max 100MB per file')).toBeInTheDocument());
  await user.upload(container.querySelector('input[type="file"]') as HTMLInputElement, files);
  await user.click(screen.getByRole('button', { name: /common\.upload/ }));
  return user;
};

const sentFiles = (call: any[]) => (call[1] as FormData).getAll('photos').map((f) => (f as File).name);

describe('PhotoUpload duplicates', () => {
  beforeEach(() => {
    postMock.mockReset();
    uploadLargeFile.mockReset();
  });

  it('lists a duplicate apart from the failures and keeps the bar up', async () => {
    postMock.mockResolvedValue({
      data: {
        count: 1, upload_id: 'u1',
        errors: [{ filename: 'broken.jpg', error: 'Corrupt file' }],
        duplicates: [{ index: 2, filename: 'copy.jpg', duplicate_of: 'IMG_0001.jpg' }],
      },
    });
    const { container } = renderWithClient(<PhotoUpload eventId={1} />);

    await selectAndUpload(container, [small('new.jpg'), small('broken.jpg'), small('copy.jpg')]);

    const duplicates = await screen.findByTestId('upload-duplicate-report');
    expect(within(duplicates).getByText('copy.jpg')).toBeInTheDocument();
    expect(within(duplicates).getByText(/same content as IMG_0001\.jpg/)).toBeInTheDocument();
    expect(within(duplicates).getByText('Duplicate')).toBeInTheDocument();
    expect(within(duplicates).queryByText('broken.jpg')).not.toBeInTheDocument();

    const failures = screen.getByTestId('upload-failure-report');
    expect(within(failures).getByText('broken.jpg')).toBeInTheDocument();
    expect(within(failures).queryByText('copy.jpg')).not.toBeInTheDocument();

    // The first request asks the server to detect duplicates.
    expect((postMock.mock.calls[0][1] as FormData).get('detect_duplicates')).toBe('true');
  });

  it('a duplicate alone is no failure and does not clear itself', async () => {
    postMock.mockResolvedValue({
      data: { count: 0, upload_id: 'u1', duplicates: [{ index: 0, filename: 'copy.jpg', duplicate_of: 'IMG_0001.jpg' }] },
    });
    const { container } = renderWithClient(<PhotoUpload eventId={1} />);

    await selectAndUpload(container, [small('copy.jpg')]);

    await screen.findByTestId('upload-duplicate-report');
    expect(screen.queryByTestId('upload-failure-report')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Dismiss/i })).toBeInTheDocument();
    // One duplicate: the per-file action is enough.
    expect(screen.queryByRole('button', { name: 'Upload all anyway' })).not.toBeInTheDocument();
  });

  it('"upload anyway" sends that file again without detection and keeps the others listed', async () => {
    postMock
      .mockResolvedValueOnce({
        data: {
          count: 0, upload_id: 'u1',
          duplicates: [
            { index: 0, filename: 'a.jpg', duplicate_of: 'first.jpg' },
            { index: 1, filename: 'b.jpg', duplicate_of: 'second.jpg' },
          ],
        },
      })
      .mockResolvedValueOnce({ data: { count: 1, upload_id: 'u2', duplicates: [] } });
    const { container } = renderWithClient(<PhotoUpload eventId={1} />);

    const user = await selectAndUpload(container, [small('a.jpg'), small('b.jpg')]);
    const report = await screen.findByTestId('upload-duplicate-report');
    await user.click(within(report).getAllByRole('button', { name: 'Upload anyway' })[1]);

    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(2));
    const second = postMock.mock.calls[1];
    expect(sentFiles(second)).toEqual(['b.jpg']);
    expect((second[1] as FormData).get('detect_duplicates')).toBeNull();
    expect((second[1] as FormData).get('replace_by_name')).toBeNull();

    await waitFor(() => {
      const remaining = screen.getByTestId('upload-duplicate-report');
      expect(within(remaining).getByText('a.jpg')).toBeInTheDocument();
      expect(within(remaining).queryByText('b.jpg')).not.toBeInTheDocument();
    });
  });

  it('"upload anyway" re-sends the skipped one of two files that share a name', async () => {
    postMock
      .mockResolvedValueOnce({
        data: { count: 1, upload_id: 'u1', duplicates: [{ index: 1, filename: 'same.jpg', duplicate_of: 'first.jpg' }] },
      })
      .mockResolvedValueOnce({ data: { count: 1, upload_id: 'u2', duplicates: [] } });
    const { container } = renderWithClient(<PhotoUpload eventId={1} />);

    const stored = new File([new Uint8Array([1])], 'same.jpg', { type: 'image/jpeg' });
    const skipped = new File([new Uint8Array([1, 2, 3, 4, 5])], 'same.jpg', { type: 'image/jpeg' });
    const user = await selectAndUpload(container, [stored, skipped]);
    expect((postMock.mock.calls[0][1] as FormData).getAll('photos').map((f) => (f as File).size)).toEqual([1, 5]);
    const report = await screen.findByTestId('upload-duplicate-report');
    const anyway = within(report).getByRole('button', { name: 'Upload anyway' });
    await waitFor(() => expect(anyway).toBeEnabled());
    await user.click(anyway);

    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(2));
    expect((postMock.mock.calls[1][1] as FormData).getAll('photos').map((f) => (f as File).size)).toEqual([5]);
  });

  it('"upload all anyway" sends every duplicate and clears the list', async () => {
    postMock
      .mockResolvedValueOnce({
        data: {
          count: 1, upload_id: 'u1',
          duplicates: [
            { index: 0, filename: 'a.jpg', duplicate_of: 'first.jpg' },
            { index: 2, filename: 'b.jpg', duplicate_of: 'second.jpg' },
          ],
        },
      })
      .mockResolvedValueOnce({ data: { count: 2, upload_id: 'u2', duplicates: [] } });
    const { container } = renderWithClient(<PhotoUpload eventId={1} />);

    const user = await selectAndUpload(container, [small('a.jpg'), small('new.jpg'), small('b.jpg')]);
    await screen.findByTestId('upload-duplicate-report');
    const all = screen.getByRole('button', { name: 'Upload all anyway' });
    await waitFor(() => expect(all).toBeEnabled());
    await user.click(all);

    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(2));
    expect(sentFiles(postMock.mock.calls[1])).toEqual(['a.jpg', 'b.jpg']);
    expect((postMock.mock.calls[1][1] as FormData).get('detect_duplicates')).toBeNull();
    await waitFor(() => expect(screen.queryByTestId('upload-duplicate-report')).not.toBeInTheDocument());
  });

  it('a large file refused as a duplicate is listed, and uploaded anyway through the chunked path', async () => {
    uploadLargeFile
      .mockRejectedValueOnce({ response: { data: { code: 'DUPLICATE_PHOTO', error: 'dup', duplicate_of: 'film.mp4' } } })
      .mockResolvedValueOnce([]);
    const { container } = renderWithClient(<PhotoUpload eventId={7} />);
    const big = new File([new Uint8Array(3 * 1024 * 1024)], 'ceremony.mp4', { type: 'video/mp4' });

    const user = await selectAndUpload(container, [big]);

    const report = await screen.findByTestId('upload-duplicate-report');
    expect(within(report).getByText(/same content as film\.mp4/)).toBeInTheDocument();
    expect(screen.queryByTestId('upload-failure-report')).not.toBeInTheDocument();
    expect(uploadLargeFile.mock.calls[0][5]).toBe(true);

    await user.click(within(report).getByRole('button', { name: 'Upload anyway' }));
    await waitFor(() => expect(uploadLargeFile).toHaveBeenCalledTimes(2));
    expect(uploadLargeFile.mock.calls[1][1]).toBe(big);
    expect(uploadLargeFile.mock.calls[1][5]).toBe(false);
    expect(postMock).not.toHaveBeenCalled();
  });
});
