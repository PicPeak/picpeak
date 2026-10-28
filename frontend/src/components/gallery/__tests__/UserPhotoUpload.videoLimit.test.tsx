/**
 * Guest videos and Max Video Size (issue 2315).
 *
 * The dialog held every file to Max File Size, so a phone video over the photo
 * limit was refused before it was sent, whatever the video limit said. It
 * also always sent one multipart request, so a file could never be larger than
 * what a proxy lets through in one body. Now each file is checked against its
 * own type's limit, and a file above the single-request budget goes through
 * the gallery's chunked upload routes.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { UserPhotoUpload } from '../UserPhotoUpload';

vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next');
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string, second?: any) => (typeof second === 'string' ? second : key),
    }),
  };
});

const toastMock = vi.hoisted(() => ({
  warning: vi.fn(), info: vi.fn(), error: vi.fn(), success: vi.fn(),
}));
vi.mock('react-toastify', () => ({ toast: toastMock }));

const postMock = vi.hoisted(() => vi.fn());
const deleteMock = vi.hoisted(() => vi.fn(async () => ({ data: {} })));
vi.mock('../../../config/api', () => ({
  api: { post: (...a: any[]) => postMock(...a), delete: (...a: any[]) => deleteMock(...a) },
}));

vi.mock('../../../hooks/usePublicSettings', () => ({
  usePublicSettings: () => ({
    data: { allowed_file_types: 'jpg,jpeg,png,mp4', general_max_file_size_mb: 1, general_max_video_size_mb: 3 },
  }),
}));

// A small single-request budget, so the test does not need a 95 MB file.
vi.mock('../../../utils/uploadMultipartBudget', () => ({ uploadMultipartBudget: () => 1000 }));

const MiB = 1024 * 1024;
const fileOf = (bytes: number, name: string, type: string) => new File([new Uint8Array(bytes)], name, { type });

const renderUploader = () => render(
  <UserPhotoUpload eventId={7} categoryId={null} onUploadComplete={vi.fn()} onClose={vi.fn()} />
);
const pick = async (container: HTMLElement, user: ReturnType<typeof userEvent.setup>, file: File) => {
  const input = container.querySelector('input[type="file"]') as HTMLInputElement;
  await user.upload(input, file);
};

describe('UserPhotoUpload video limit and chunked upload', () => {
  beforeEach(() => { postMock.mockReset(); deleteMock.mockClear(); });
  afterEach(() => vi.clearAllMocks());

  it('holds a video to Max Video Size and a photo to Max File Size', async () => {
    const user = userEvent.setup();
    const { container } = renderUploader();

    await pick(container, user, fileOf(2 * MiB, 'clip.mp4', 'video/mp4'));
    expect(toastMock.error).not.toHaveBeenCalled();
    expect(screen.getByText('clip.mp4')).toBeInTheDocument();

    await pick(container, user, fileOf(2 * MiB, 'big.jpg', 'image/jpeg'));
    expect(toastMock.error).toHaveBeenLastCalledWith('upload.fileTooLarge');
    expect(screen.queryByText('big.jpg')).not.toBeInTheDocument();

    await pick(container, user, fileOf(4 * MiB, 'long.mp4', 'video/mp4'));
    expect(toastMock.error).toHaveBeenCalledTimes(2);
    expect(screen.queryByText('long.mp4')).not.toBeInTheDocument();
  });

  it('names the video limit beside the file requirements', () => {
    renderUploader();
    expect(screen.getByText('Videos: max {{sizeLimit}}MB per file')).toBeInTheDocument();
  });

  it('sends a file above the single-request budget in chunks, and one below it in one request', async () => {
    postMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/chunked-upload/init')) return { data: { uploadId: 'up-1', chunkSize: 1024, expectedChunks: 2 } };
      if (url.includes('/chunk/')) return { data: { progress: 50 } };
      return { data: { upload_id: 'g1', count: 1 } };
    });
    const user = userEvent.setup();
    const { container } = renderUploader();
    await pick(container, user, fileOf(1500, 'clip.mp4', 'video/mp4'));
    await pick(container, user, fileOf(500, 'small.mp4', 'video/mp4'));
    await user.click(screen.getByRole('button', { name: /common\.upload/ }));

    await waitFor(() => expect(toastMock.success).toHaveBeenCalled());
    const urls = postMock.mock.calls.map(([url]) => url);
    expect(urls).toEqual([
      '/gallery/7/chunked-upload/init',
      '/gallery/7/chunked-upload/up-1/chunk/0',
      '/gallery/7/chunked-upload/up-1/chunk/1',
      '/gallery/7/chunked-upload/up-1/complete',
      '/gallery/7/upload',
    ]);
    expect(postMock.mock.calls[0][1]).toEqual({ filename: 'clip.mp4', fileSize: 1500 });
    expect((postMock.mock.calls[1][1] as Blob).size).toBe(1024);
    expect((postMock.mock.calls[2][1] as Blob).size).toBe(476);
    expect(postMock.mock.calls[1][2].headers['Content-Type']).toBe('application/octet-stream');
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it('aborts a chunked upload that fails and reports the server\'s reason', async () => {
    postMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/chunked-upload/init')) return { data: { uploadId: 'up-2', chunkSize: 1024, expectedChunks: 2 } };
      throw Object.assign(new Error('Request failed'), { response: { status: 400, data: { error: 'Invalid video file content.' } } });
    });
    const user = userEvent.setup();
    const { container } = renderUploader();
    await pick(container, user, fileOf(1500, 'clip.mp4', 'video/mp4'));
    await user.click(screen.getByRole('button', { name: /common\.upload/ }));

    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith('clip.mp4: Invalid video file content.'));
    expect(deleteMock).toHaveBeenCalledWith('/gallery/7/chunked-upload/up-2', expect.anything());
    expect(toastMock.success).not.toHaveBeenCalled();
  });
});
