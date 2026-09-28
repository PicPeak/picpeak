/**
 * Issue 1711: the trash action called DELETE /admin/backup/runs/:id, which did
 * not exist, so every click was a 404 and the row stayed. The route exists
 * now; this pins the UI contract around it: localized confirmation, the
 * history query invalidated only after a successful deletion, and the
 * server's stable error codes shown as translated messages.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const api = vi.hoisted(() => ({ get: vi.fn(), delete: vi.fn() }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));

vi.mock('../../../config/api', () => ({ api }));
vi.mock('react-toastify', () => ({ toast }));
vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next');
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string, options?: Record<string, unknown>) =>
        options && typeof options === 'object' && 'date' in options ? `${key}:${options.date}` : key,
      i18n: { language: 'en' },
    }),
  };
});
vi.mock('../../../hooks/useLocalizedDate', () => ({
  useLocalizedDate: () => ({
    format: (d: Date) => d.toISOString().slice(0, 10),
    formatTime: () => '02:00',
    formatDistanceToNow: () => '3 days ago',
  }),
}));

import { BackupHistory } from '../BackupHistory';

const history = {
  recentBackups: [
    {
      id: 42,
      status: 'completed',
      created_at: '2026-09-01T02:00:00Z',
      completed_at: '2026-09-01T02:05:00Z',
      backup_type: 'full',
      duration_seconds: 300,
      manifest_path: '/srv/backups/manifests/backup-manifest-42.json',
      statistics: { total_size: 1024, files_processed: 3 },
    },
  ],
  pagination: { page: 1, pages: 1, total: 1 },
};

const axiosError = (status: number, data: Record<string, unknown>) =>
  Object.assign(new Error('request failed'), { response: { status, data } });

function renderHistory() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  render(
    <QueryClientProvider client={client}>
      <BackupHistory />
    </QueryClientProvider>
  );
  return { invalidate };
}

async function clickDelete() {
  const button = await screen.findByRole('button', { name: 'backup.actions.delete' });
  fireEvent.click(button);
}

beforeEach(() => {
  api.get.mockReset().mockResolvedValue({ data: history });
  api.delete.mockReset();
  toast.success.mockReset();
  toast.error.mockReset();
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});

describe('BackupHistory delete (issue 1711)', () => {
  it('asks a localized confirmation with the backup date and calls the individual delete route', async () => {
    api.delete.mockResolvedValue({ data: { success: true, id: 42, destination: 'local', artifact: { status: 'deleted' } } });
    const { invalidate } = renderHistory();
    await clickDelete();

    expect(window.confirm).toHaveBeenCalledWith('backup.history.deleteConfirm:2026-09-01');
    await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/admin/backup/runs/42'));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('backup.history.deleteSuccess'));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['backup-history'] });
  });

  it('says so when the record went but its files were already missing', async () => {
    api.delete.mockResolvedValue({ data: { success: true, id: 42, destination: 'local', artifact: { status: 'missing' } } });
    renderHistory();
    await clickDelete();
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('backup.history.deleteSuccessArtifactMissing'));
  });

  it('does nothing when the confirmation is declined', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    const { invalidate } = renderHistory();
    await clickDelete();
    expect(api.delete).not.toHaveBeenCalled();
    expect(invalidate).not.toHaveBeenCalled();
  });

  it.each([
    [409, 'ARTIFACT_OUT_OF_SCOPE'],
    [500, 'ARTIFACT_DELETE_FAILED'],
    [409, 'BACKUP_RUNNING'],
    [404, 'BACKUP_NOT_FOUND'],
    [403, 'FORBIDDEN'],
  ])('shows the translated message for a %s %s and leaves the history query alone', async (status, code) => {
    api.delete.mockRejectedValue(axiosError(status, { error: 'server text', code }));
    const { invalidate } = renderHistory();
    await clickDelete();

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(`backup.history.deleteErrors.${code}`));
    expect(toast.success).not.toHaveBeenCalled();
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('falls back to the generic message for an unknown failure', async () => {
    api.delete.mockRejectedValue(new Error('network down'));
    renderHistory();
    await clickDelete();
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('backup.history.deleteError'));
  });
});
