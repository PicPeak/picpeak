/**
 * Two ends of a session that the bar's move out of the modal made possible.
 *
 * - The provider lives in AdminLayout. When it unmounts (logout, the 401
 *   redirect) the transfer loop must stop: later batches would otherwise
 *   keep POSTing into a session nobody sees.
 * - When the worker's status cannot be read (the hook gives up after a run
 *   of failures) the session ends with what is known and says so, rather
 *   than sitting in "processing" for good.
 */
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PhotoUpload } from '../PhotoUpload';
import { renderWithUploadSession as renderWithClient } from './uploadTestUtils';

vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next');
  return { ...actual, useTranslation: () => ({ t: (key: string) => key }) };
});

const toastMock = vi.hoisted(() => ({ warning: vi.fn(), info: vi.fn(), error: vi.fn(), success: vi.fn() }));
vi.mock('react-toastify', () => ({ toast: toastMock }));

const postMock = vi.fn();
vi.mock('../../../config/api', () => ({ api: { post: (...a: any[]) => postMock(...a), get: vi.fn() } }));

const hoisted = vi.hoisted(() => ({ stalled: false }));
vi.mock('../../../hooks/useUploadProgress', () => ({
  useUploadProgress: (ids: string[]) => ({
    snapshots: {},
    error: null,
    aggregate: {
      total: ids.length, pending: ids.length, processing: 0, complete: 0, failed: 0, failedPhotos: [],
      isComplete: false, isReady: true, isStalled: ids.length > 0 && hoisted.stalled,
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

const file = (name: string, mb = 1) => new File([new Uint8Array(mb * 1024 * 1024)], name, { type: 'image/jpeg' });

async function pickAndUpload(container: HTMLElement, files: File[]) {
  const user = userEvent.setup();
  await waitFor(() => expect(screen.getByText('upload.videoSizeLimit')).toBeInTheDocument());
  const input = container.querySelector('input[type="file"]') as HTMLInputElement;
  await user.upload(input, files);
  await user.click(screen.getByRole('button', { name: /common\.upload/ }));
}

describe('upload session lifecycle', () => {
  beforeEach(() => { postMock.mockReset(); hoisted.stalled = false; });
  afterEach(() => vi.clearAllMocks());

  it('stops the transfer loop when the provider unmounts', async () => {
    let releaseFirst!: (v: unknown) => void;
    postMock.mockImplementationOnce(() => new Promise((resolve) => { releaseFirst = resolve; }));
    const { container, unmount } = renderWithClient(<PhotoUpload eventId={1} />);

    // Three 1MB files under a 2MB cap: two batches.
    await pickAndUpload(container, [file('a.jpg'), file('b.jpg'), file('c.jpg')]);
    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));

    unmount();
    releaseFirst({ data: { count: 2, upload_id: 'u1', errors: [] } });
    await new Promise((r) => setTimeout(r, 50));
    expect(postMock).toHaveBeenCalledTimes(1);
    expect(toastMock.error).not.toHaveBeenCalled();
  });

  it('ends the session with what it knows when the status cannot be read', async () => {
    hoisted.stalled = true;
    postMock.mockResolvedValue({ data: { count: 1, upload_id: 'u1', errors: [] } });
    const { container } = renderWithClient(<PhotoUpload eventId={1} />);

    await pickAndUpload(container, [file('a.jpg', 0.5)]);

    expect(await screen.findByText('upload.bar.statusUnavailable')).toBeInTheDocument();
    expect(toastMock.warning).toHaveBeenCalledWith('upload.bar.statusUnavailable');
    expect(toastMock.success).not.toHaveBeenCalled();
    // Stays until dismissed: the note is the point.
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.getByText('upload.bar.statusUnavailable')).toBeInTheDocument();
  });
});
