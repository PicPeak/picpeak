/**
 * Guest videos and Max Video Size (issue 2315).
 *
 * The dialog held every file to Max File Size, so a phone video over the photo
 * limit was refused before it was sent, whatever the video limit said. Now
 * each file is checked against its own type's limit.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

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

vi.mock('../../../config/api', () => ({ api: { post: vi.fn() } }));

vi.mock('../../../hooks/usePublicSettings', () => ({
  usePublicSettings: () => ({
    data: { allowed_file_types: 'jpg,jpeg,png,mp4', general_max_file_size_mb: 1, general_max_video_size_mb: 3 },
  }),
}));

const MiB = 1024 * 1024;
const fileOf = (bytes: number, name: string, type: string) => new File([new Uint8Array(bytes)], name, { type });

const renderUploader = () => render(
  <UserPhotoUpload eventId={7} categoryId={null} onUploadComplete={vi.fn()} onClose={vi.fn()} />
);
const pick = async (container: HTMLElement, user: ReturnType<typeof userEvent.setup>, file: File) => {
  const input = container.querySelector('input[type="file"]') as HTMLInputElement;
  await user.upload(input, file);
};

describe('UserPhotoUpload video limit', () => {
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
});
