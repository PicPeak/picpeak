/**
 * A file request's files-per-upload limit in the admin UI (issue 1914).
 *
 * The create dialog shows the global default as the placeholder and sends an
 * own limit only when one was typed. The detail view names the limit in
 * force, saves an own value and hands it back to the default.
 */
import { render, screen, waitFor } from '@testing-library/react';
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
        const text = typeof fallback === 'string' ? fallback : _key;
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
vi.mock('../../../../hooks/usePermission', () => ({ usePermission: () => true }));
vi.mock('../../../../services/transfers.service', () => ({
  transfersService: {
    list: vi.fn(), get: vi.fn(), create: vi.fn(), update: vi.fn(), uploadDefaults: vi.fn(),
    adminUploadsDownloadUrl: () => '#', adminUploadDownloadUrl: () => '#', adminDownloadUrl: () => '#',
  },
}));

const request = (own: number | null, effective: number) => ({
  id: 7, token: 'a'.repeat(64), kind: 'request', title: 'Send your photos', message: null,
  expires_at: '2026-11-01T00:00:00.000Z', max_downloads: null, download_count: 0, downloads_remaining: null,
  is_active: true, disabled_at: null, grace_days: 7, deleted_at: null, allow_uploads: true, delivery_method: 'link',
  upload_token: null, upload_expires_at: null, created_at: '2026-10-01T00:00:00.000Z', updated_at: '2026-10-01T00:00:00.000Z',
  status: 'active', download_url: null, upload_url: '/transfer-upload/' + 'a'.repeat(64), upload_code: null, upload_code_url: null,
  file_count: 0, upload_count: 0, files: [], extra_files: [], recipients: [], uploads: [],
  max_files_per_upload: own, effective_max_files_per_upload: effective,
});

function show() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <ConfirmDialogProvider>
        <TransfersPage />
      </ConfirmDialogProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(transfersService.list).mockResolvedValue([]);
  vi.mocked(transfersService.uploadDefaults).mockResolvedValue({ max_files_per_upload: 100, max_files_ceiling: 1000 });
});

describe('creating a file request', () => {
  async function openDialog() {
    const user = userEvent.setup();
    show();
    await user.click((await screen.findAllByRole('button', { name: 'Request files' }))[0]);
    await user.click(screen.getByRole('button', { name: 'Share a link' }));
    const field = await screen.findByLabelText('Max files per upload');
    await waitFor(() => expect(field).toHaveAttribute('placeholder', 'Default (100)'));
    return { user, field };
  }

  it('shows the default and sends no own limit when the field is left empty', async () => {
    vi.mocked(transfersService.create).mockResolvedValue({ transfer: request(null, 100) } as never);
    const { user } = await openDialog();
    await user.click(screen.getByRole('button', { name: 'Create request' }));
    await waitFor(() => expect(transfersService.create).toHaveBeenCalledTimes(1));
    expect(vi.mocked(transfersService.create).mock.calls[0][0]).toMatchObject({ kind: 'request', maxFilesPerUpload: null });
  });

  it('sends the typed limit', async () => {
    vi.mocked(transfersService.create).mockResolvedValue({ transfer: request(300, 300) } as never);
    const { user, field } = await openDialog();
    await user.type(field, '300');
    await user.click(screen.getByRole('button', { name: 'Create request' }));
    await waitFor(() => expect(transfersService.create).toHaveBeenCalledTimes(1));
    expect(vi.mocked(transfersService.create).mock.calls[0][0]).toMatchObject({ kind: 'request', maxFilesPerUpload: 300 });
  });
});

// parseInt read a prefix: "1e2" (100 to a number input) was saved as 1 and
// "2.5" as 2, a limit other than the one on screen.
describe('the limit field takes the whole value', () => {
  it('reads 1e2 as one hundred and refuses a fraction', async () => {
    vi.mocked(transfersService.create).mockResolvedValue({ transfer: request(100, 100) } as never);
    const user = userEvent.setup();
    show();
    await user.click((await screen.findAllByRole('button', { name: 'Request files' }))[0]);
    await user.click(screen.getByRole('button', { name: 'Share a link' }));
    const field = await screen.findByLabelText('Max files per upload');

    await user.type(field, '2.5');
    expect(screen.getByRole('button', { name: 'Create request' })).toBeDisabled();
    expect(screen.getByText('A whole number from 1 to 1000')).toBeInTheDocument();

    await user.clear(field);
    await user.type(field, '1e2');
    await user.click(screen.getByRole('button', { name: 'Create request' }));
    await waitFor(() => expect(transfersService.create).toHaveBeenCalledTimes(1));
    expect(vi.mocked(transfersService.create).mock.calls[0][0]).toMatchObject({ maxFilesPerUpload: 100 });
  });
});

describe('a request\'s detail view', () => {
  async function openDetail(own: number | null, effective: number) {
    vi.mocked(transfersService.list).mockResolvedValue([request(own, effective)] as never);
    vi.mocked(transfersService.get).mockResolvedValue(request(own, effective) as never);
    const user = userEvent.setup();
    show();
    await user.click(await screen.findByText('Send your photos'));
    return user;
  }

  it('names the default in force and saves an own limit', async () => {
    vi.mocked(transfersService.update).mockResolvedValue(request(40, 40) as never);
    const user = await openDetail(null, 100);
    expect(await screen.findByText(/up to 100 files at once \(the default from Settings\)/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Use the default' })).toBeNull();
    await user.type(screen.getByLabelText('Max files per upload'), '40');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(transfersService.update).toHaveBeenCalledWith(7, { maxFilesPerUpload: 40 }));
  });

  it('hands an own limit back to the default', async () => {
    vi.mocked(transfersService.update).mockResolvedValue(request(null, 100) as never);
    const user = await openDetail(300, 300);
    expect(await screen.findByText(/up to 300 files at once\. This request has its own limit/)).toBeInTheDocument();
    expect(screen.getByLabelText('Max files per upload')).toHaveValue(300);
    await user.click(screen.getByRole('button', { name: 'Use the default' }));
    await waitFor(() => expect(transfersService.update).toHaveBeenCalledWith(7, { maxFilesPerUpload: null }));
  });
});
