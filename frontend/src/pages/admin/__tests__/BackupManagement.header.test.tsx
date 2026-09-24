/**
 * Issue 1641: the header showed a green "Last backup" for whatever the newest
 * run was, so a failed attempt looked like a success while the dashboard said
 * it failed. It now follows the newest attempt's status.
 */
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';

import { BackupManagement } from '../BackupManagement';

const { get } = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock('../../../config/api', () => ({ api: { get, post: vi.fn(), put: vi.fn() } }));
vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next');
  return {
    ...actual,
    useTranslation: () => ({ t: (k: string, fb?: unknown) => (typeof fb === 'string' ? fb : k), i18n: { language: 'en' } }),
  };
});
vi.mock('../../../contexts/AdminAuthContext', () => ({
  useAdminAuth: () => ({ user: { role: { name: 'super_admin' } } }),
}));
vi.mock('../../../hooks/useLocalizedDate', () => ({
  useLocalizedDate: () => ({ formatDateTime: (value: string) => `at ${value}` }),
}));
// The tabs are not under test.
vi.mock('../../../components/admin/BackupDashboard', () => ({ BackupDashboard: () => null }));
vi.mock('../../../components/admin/BackupConfiguration', () => ({ BackupConfiguration: () => null }));
vi.mock('../../../components/admin/BackupHistory', () => ({ BackupHistory: () => null }));
vi.mock('../../../components/admin/RestoreWizard', () => ({ RestoreWizard: () => null }));
vi.mock('../../../components/admin/PicpeakBackupCard', () => ({ PicpeakExportCard: () => null }));
vi.mock('../../../components/admin/BackupIntegrityCard', () => ({ BackupIntegrityCard: () => null }));
vi.mock('../../../components/admin/BackupCoverageCard', () => ({ BackupCoverageCard: () => null }));

const completed = { id: 1, status: 'completed', created_at: '2026-09-23T03:00:00Z' };
const failed = { id: 2, status: 'failed', created_at: '2026-09-24T08:38:00Z' };
const running = { id: 3, status: 'running', created_at: '2026-09-24T09:00:00Z' };

const renderWithStatus = async (status: Record<string, unknown>) => {
  get.mockImplementation(async (url: string) => ({
    data: url.endsWith('/status') ? { isRunning: false, ...status } : { backup_enabled: true },
  }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><BackupManagement /></QueryClientProvider>);
  await screen.findByText('backup.title');
};

describe('BackupManagement header', () => {
  it('shows a failed newest attempt in red, next to the last success', async () => {
    await renderWithStatus({ lastBackup: failed, lastSuccessfulBackup: completed });

    const label = screen.getByText(/backup.status.latestAttemptFailed/);
    expect(label).toHaveClass('text-red-700');
    expect(label).toHaveTextContent(`at ${failed.created_at}`);
    expect(screen.getByText(/backup.status.lastSuccessfulBackup/)).toHaveTextContent(`at ${completed.created_at}`);
    expect(screen.queryByText(/backup.status.lastBackup:/)).not.toBeInTheDocument();
  });

  it('shows a running newest attempt in blue', async () => {
    await renderWithStatus({ lastBackup: running, lastSuccessfulBackup: completed });
    expect(screen.getByText(/backup.status.latestAttemptRunning/)).toHaveClass('text-blue-600');
  });

  it('shows a completed newest attempt as the last backup, in green', async () => {
    await renderWithStatus({ lastBackup: completed, lastSuccessfulBackup: completed });
    const label = screen.getByText(/backup.status.lastBackup:/);
    expect(label.previousElementSibling).toHaveClass('text-green-500');
  });
});
