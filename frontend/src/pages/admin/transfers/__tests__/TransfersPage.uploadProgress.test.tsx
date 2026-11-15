/**
 * Upload progress in the admin PicTransfer dialogs.
 *
 * Files sent with a new transfer, or added to an existing one, went up with
 * no sign of progress: a large upload looked like a hung request. Both paths
 * now show the share sent, then "saving" until the server answers.
 */
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { ConfirmDialogProvider } from '../../../../components/common';
import { TransfersPage } from '../TransfersPage';
import { transfersService } from '../../../../services/transfers.service';

vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next');
  return {
    ...actual,
    useTranslation: () => ({
      t: (_key: string, fallback?: any, options?: Record<string, unknown>) => {
        const text = typeof fallback === 'string' ? fallback : (fallback?.defaultValue ?? _key);
        const values = (typeof fallback === 'object' ? fallback : options) || {};
        return text.replace(/\{\{(\w+)\}\}/g, (_m: string, name: string) => String(values[name] ?? ''));
      },
    }),
  };
});
vi.mock('react-toastify', () => ({
  toast: { warning: vi.fn(), info: vi.fn(), error: vi.fn(), success: vi.fn() },
}));
vi.mock('../../../../hooks/useLocalizedDate', () => ({
  useLocalizedDate: () => ({ formatDateTime: (v: string) => v, formatDate: (v: string) => v }),
}));
vi.mock('../../../../services/transfers.service', () => ({
  transfersService: {
    list: vi.fn(), get: vi.fn(), create: vi.fn(), update: vi.fn(), uploadFiles: vi.fn(),
    adminUploadsDownloadUrl: () => '#', adminUploadDownloadUrl: () => '#', adminDownloadUrl: () => '#',
    adminExtraFileDownloadUrl: () => '#',
  },
}));

const send = () => ({
  id: 9, token: 'b'.repeat(64), kind: 'send', title: 'Wedding finals', message: null,
  expires_at: '2026-11-01T00:00:00.000Z', max_downloads: null, download_count: 0, downloads_remaining: null,
  is_active: true, disabled_at: null, grace_days: 7, deleted_at: null, allow_uploads: false, delivery_method: 'link',
  upload_token: null, upload_expires_at: null, created_at: '2026-10-01T00:00:00.000Z', updated_at: '2026-10-01T00:00:00.000Z',
  status: 'active', download_url: '/transfer/' + 'b'.repeat(64), upload_url: null, upload_code: null, upload_code_url: null,
  file_count: 0, upload_count: 0, files: [], extra_files: [], recipients: [], uploads: [],
});

function show() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ConfirmDialogProvider>
        <TransfersPage />
      </ConfirmDialogProvider>
    </QueryClientProvider>,
  );
}

/** A service call that reports progress when told to and settles on demand. */
function pendingUpload() {
  let report: ((pct: number) => void) | undefined;
  let finish: (value: unknown) => void = () => {};
  const impl = (...args: unknown[]) => {
    report = args.find((a) => typeof a === 'function') as typeof report;
    return new Promise((resolve) => { finish = resolve; });
  };
  return { impl, progress: (pct: number) => act(() => report?.(pct)), done: (value: unknown) => act(async () => finish(value)) };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(transfersService.list).mockResolvedValue([]);
});

describe('upload progress', () => {
  it('shows the progress of the files sent with a new transfer', async () => {
    const upload = pendingUpload();
    vi.mocked(transfersService.create).mockImplementation(upload.impl as never);
    const user = userEvent.setup();
    const { container } = show();
    await user.click(await screen.findByRole('button', { name: 'New transfer' }));
    const input = container.ownerDocument.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(input, new File(['x'.repeat(10)], 'film.mp4', { type: 'video/mp4' }));
    await user.click(screen.getByRole('button', { name: 'Create transfer' }));

    await waitFor(() => expect(transfersService.create).toHaveBeenCalledTimes(1));
    expect(screen.getByLabelText('Upload progress')).toBeInTheDocument();
    await upload.progress(42);
    expect(screen.getByText('Uploading… 42%')).toBeInTheDocument();
    await upload.progress(100);
    expect(screen.getByText('Upload complete, saving the files…')).toBeInTheDocument();

    await upload.done({ ...send(), rejected_files: [], dropped_files: [] });
    await waitFor(() => expect(screen.queryByLabelText('Upload progress')).toBeNull());
  });

  it('shows the progress of files added to an existing transfer', async () => {
    vi.mocked(transfersService.list).mockResolvedValue([send()] as never);
    vi.mocked(transfersService.get).mockResolvedValue(send() as never);
    const upload = pendingUpload();
    vi.mocked(transfersService.uploadFiles).mockImplementation(upload.impl as never);
    const user = userEvent.setup();
    const { container } = show();
    await user.click(await screen.findByText('Wedding finals'));
    await screen.findByText('Add files');

    const input = container.ownerDocument.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(input, new File(['x'.repeat(10)], 'album.pdf', { type: 'application/pdf' }));
    await waitFor(() => expect(transfersService.uploadFiles).toHaveBeenCalledTimes(1));
    await upload.progress(7);
    expect(screen.getByText('Uploading… 7%')).toBeInTheDocument();
    expect(input).toBeDisabled();

    await upload.done({ ...send(), rejected_files: [], dropped_files: [] });
    await waitFor(() => expect(screen.queryByLabelText('Upload progress')).toBeNull());
  });
});
