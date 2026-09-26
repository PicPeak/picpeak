/**
 * Upload session + progress bar (discussion 1541).
 *
 * The modal used to hold the user until processing finished. Now the picker
 * hands the files to UploadSessionProvider and closes; UploadProgressBar shows
 * the transfer, then processing, then the outcome. Pins:
 *  - the modal closes while the POST is still in flight and the bar is up
 *  - a second upload is blocked while one runs
 *  - a clean finish shows the uploaded count and can be dismissed
 *  - the bar links back to the event from any other admin page
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PhotoUpload } from '../PhotoUpload';
import { PhotoUploadModal } from '../PhotoUploadModal';
import { renderWithUploadSession } from './uploadTestUtils';

vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next');
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string, second?: any) => (typeof second === 'string' ? second : key),
    }),
  };
});

vi.mock('react-toastify', () => ({
  toast: { warning: vi.fn(), info: vi.fn(), error: vi.fn(), success: vi.fn() },
}));

const postMock = vi.fn();
vi.mock('../../../config/api', () => ({ api: { post: (...a: any[]) => postMock(...a), get: vi.fn() } }));

const hoisted = vi.hoisted(() => ({ aggregate: null as any }));
const idle = {
  total: 0, pending: 0, processing: 0, complete: 0, failed: 0,
  failedPhotos: [] as { id: number; filename: string; error: string | null }[],
  isComplete: false, isReady: true,
};
vi.mock('../../../hooks/useUploadProgress', () => ({
  useUploadProgress: (ids: string[]) => ({
    snapshots: {},
    error: null,
    aggregate: ids && ids.length > 0 ? hoisted.aggregate : idle,
  }),
}));

vi.mock('../../../services/categories.service', () => ({
  categoriesService: { getEventCategories: vi.fn().mockResolvedValue([]) },
}));
vi.mock('../../../services/settings.service', () => ({
  settingsService: { getAllSettings: vi.fn().mockResolvedValue({}) },
}));

const makeFile = (name: string) => new File([new Uint8Array([1, 2, 3])], name, { type: 'image/png' });

async function pickAndUpload(container: HTMLElement, user: ReturnType<typeof userEvent.setup>, names: string[]) {
  const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
  await user.upload(fileInput, names.map(makeFile));
  await user.click(screen.getByRole('button', { name: /common\.upload/ }));
}

// A POST we control: resolve() lets the transfer finish when the test says so.
function deferredPost() {
  let resolve!: (value: unknown) => void;
  const promise = new Promise((r) => { resolve = r; });
  postMock.mockReturnValue(promise);
  return { resolve };
}

describe('UploadProgressBar', () => {
  beforeEach(() => {
    postMock.mockReset();
    hoisted.aggregate = { ...idle };
  });
  afterEach(() => vi.clearAllMocks());

  it('closes the modal while the transfer is still running and shows the bar', async () => {
    const { resolve } = deferredPost();
    const onClose = vi.fn();
    const user = userEvent.setup();
    const { container } = renderWithUploadSession(<PhotoUploadModal isOpen eventId={1} onClose={onClose} />);

    await pickAndUpload(container, user, ['a.png', 'b.png']);

    expect(onClose).toHaveBeenCalledTimes(1);
    const bar = await screen.findByTestId('upload-progress-bar');
    expect(within(bar).getByText(/upload\.bar\.uploading/)).toBeInTheDocument();
    expect(within(bar).getByText('0%')).toBeInTheDocument();
    // Already on the event page — no link back to it.
    expect(within(bar).queryByText('View event')).not.toBeInTheDocument();

    resolve({ data: { count: 2, upload_id: 'u1', errors: [] } });
  });

  it('blocks a second upload while one is running', async () => {
    deferredPost();
    const user = userEvent.setup();
    const { container } = renderWithUploadSession(<PhotoUpload eventId={1} />);

    await pickAndUpload(container, user, ['a.png']);

    expect(await screen.findByText(/An upload is already running/)).toBeInTheDocument();
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(fileInput, [makeFile('b.png')]);
    expect(screen.getByRole('button', { name: /common\.upload/ })).toBeDisabled();
    expect(postMock).toHaveBeenCalledTimes(1);
  });

  it('shows the uploaded count when processing finishes and can be dismissed', async () => {
    postMock.mockResolvedValue({ data: { count: 1, upload_id: 'u1', errors: [] } });
    hoisted.aggregate = {
      total: 1, pending: 0, processing: 0, complete: 1, failed: 0,
      failedPhotos: [], isComplete: true, isReady: true,
    };
    const user = userEvent.setup();
    const { container } = renderWithUploadSession(<PhotoUpload eventId={1} />);

    await pickAndUpload(container, user, ['a.png']);

    const bar = await screen.findByTestId('upload-progress-bar');
    await waitFor(() => expect(within(bar).getByText('upload.bar.uploaded')).toBeInTheDocument());
    expect(screen.queryByTestId('upload-failure-report')).not.toBeInTheDocument();

    await user.click(within(bar).getByRole('button', { name: /Dismiss/i }));
    expect(screen.queryByTestId('upload-progress-bar')).not.toBeInTheDocument();
  });

  it('links back to the event from another admin page', async () => {
    deferredPost();
    const user = userEvent.setup();
    const { container } = renderWithUploadSession(<PhotoUpload eventId={42} />, '/admin/dashboard');

    await pickAndUpload(container, user, ['a.png']);

    const bar = await screen.findByTestId('upload-progress-bar');
    const link = within(bar).getByRole('link', { name: 'View event' });
    expect(link).toHaveAttribute('href', '/admin/events/42');
  });
});
