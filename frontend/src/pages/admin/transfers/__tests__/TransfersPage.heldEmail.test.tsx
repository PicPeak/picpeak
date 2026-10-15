/**
 * A send's ready email waits while no photo has finished processing (issue
 * 2061). The detail view shows such a recipient as waiting, not "Emailed to",
 * and a Send again the server held says so instead of "Email sent again".
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { toast } from 'react-toastify';

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
    list: vi.fn(), get: vi.fn(), resendEmail: vi.fn(), uploadDefaults: vi.fn(),
    adminUploadsDownloadUrl: () => '#', adminUploadDownloadUrl: () => '#', adminDownloadUrl: () => '#',
  },
}));

const send = (recipients: Array<{ id: number; email: string; held: boolean }>) => ({
  id: 9, token: 'b'.repeat(64), kind: 'send', title: 'Wedding finals', message: null,
  expires_at: '2026-11-01T00:00:00.000Z', max_downloads: null, download_count: 0, downloads_remaining: null,
  is_active: true, disabled_at: null, grace_days: 7, deleted_at: null, allow_uploads: false, delivery_method: 'email',
  upload_token: null, upload_expires_at: null, created_at: '2026-10-01T00:00:00.000Z', updated_at: '2026-10-01T00:00:00.000Z',
  status: 'active', download_url: '/transfer/' + 'b'.repeat(64), upload_url: null, upload_code: null, upload_code_url: null,
  file_count: 1, upload_count: 0, files: [], extra_files: [], uploads: [],
  recipients: recipients.map((r) => ({ ...r, last_sent_at: r.held ? null : '2026-10-02T00:00:00.000Z' })),
  max_files_per_upload: null, effective_max_files_per_upload: null,
});

async function openDetail(transfer: ReturnType<typeof send>) {
  vi.mocked(transfersService.list).mockResolvedValue([transfer] as never);
  vi.mocked(transfersService.get).mockResolvedValue(transfer as never);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <ConfirmDialogProvider>
        <TransfersPage />
      </ConfirmDialogProvider>
    </QueryClientProvider>,
  );
  const user = userEvent.setup();
  await user.click(await screen.findByText('Wedding finals'));
  return user;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(transfersService.uploadDefaults).mockResolvedValue({ max_files_per_upload: 100, max_files_ceiling: 1000 });
});

describe('a held ready email in the detail view', () => {
  it('lists a held recipient as waiting, not as emailed', async () => {
    await openDetail(send([{ id: 1, email: 'anna@example.com', held: true }]));
    const held = await screen.findByTestId('transfer-held-recipients');
    expect(within(held).getByText('Email waits until a photo is ready')).toBeInTheDocument();
    expect(within(held).getByText('Not sent yet')).toBeInTheDocument();
    expect(within(held).getByText('anna@example.com')).toBeInTheDocument();
    expect(screen.queryByText('Emailed to')).toBeNull();
  });

  it('keeps a sent recipient under Emailed to', async () => {
    await openDetail(send([
      { id: 1, email: 'anna@example.com', held: false },
      { id: 2, email: 'ben@example.com', held: true },
    ]));
    const emailed = (await screen.findByText('Emailed to')).closest('div')!;
    expect(within(emailed).getByText('anna@example.com')).toBeInTheDocument();
    expect(within(emailed).queryByText('ben@example.com')).toBeNull();
    expect(within(screen.getByTestId('transfer-held-recipients')).getByText('ben@example.com')).toBeInTheDocument();
  });
});

describe('Send again', () => {
  it('says the email waits when the server held it', async () => {
    const transfer = send([{ id: 1, email: 'anna@example.com', held: true }]);
    vi.mocked(transfersService.resendEmail).mockResolvedValue({ transfer, held: true } as never);
    const user = await openDetail(transfer);
    await user.click(await screen.findByRole('button', { name: 'Send again' }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Email held until a photo is ready'));
    expect(toast.success).not.toHaveBeenCalledWith('Email sent again');
  });

  it('says sent when it was sent', async () => {
    const transfer = send([{ id: 1, email: 'anna@example.com', held: false }]);
    vi.mocked(transfersService.resendEmail).mockResolvedValue({ transfer, held: false } as never);
    const user = await openDetail(transfer);
    await user.click(await screen.findByRole('button', { name: 'Send again' }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Email sent again'));
  });
});
