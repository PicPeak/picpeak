/**
 * Issue 1641: the header showed a green "Last backup" for whatever the newest
 * run was, so a failed attempt looked like a success while the dashboard said
 * it failed. It now follows the newest attempt's status.
 */
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BackupManagement } from '../BackupManagement';

const { get, auth } = vi.hoisted(() => ({ get: vi.fn(), auth: { role: 'super_admin' } }));

vi.mock('../../../config/api', () => ({ api: { get, post: vi.fn(), put: vi.fn() } }));
vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next');
  return {
    ...actual,
    useTranslation: () => ({ t: (k: string, fb?: unknown) => (typeof fb === 'string' ? fb : k), i18n: { language: 'en' } }),
  };
});
vi.mock('../../../contexts/AdminAuthContext', () => ({
  useAdminAuth: () => ({ user: { role: { name: auth.role } } }),
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
vi.mock('../../../components/admin/RestoreTestCard', () => ({ RestoreTestCard: () => null }));
vi.mock('../../../contexts/FeatureFlagsContext', () => ({ useFeatureFlags: () => ({ flags: { backupRestoreTest: false } }) }));

const completed = { id: 1, status: 'completed', created_at: '2026-09-23T03:00:00Z' };
const failed = { id: 2, status: 'failed', created_at: '2026-09-24T08:38:00Z' };
const running = { id: 3, status: 'running', created_at: '2026-09-24T09:00:00Z' };

const renderWithStatus = async (status: Record<string, unknown>) => {
  get.mockImplementation(async (url: string) => ({
    data: url.endsWith('/status') ? { isRunning: false, ...status } : { backup_enabled: true },
  }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<MemoryRouter><QueryClientProvider client={client}><BackupManagement /></QueryClientProvider></MemoryRouter>);
  await screen.findByText('backup.title');
};

describe('BackupManagement header', () => {
  it('shows a failed newest attempt in red, next to the last success', async () => {
    await renderWithStatus({ lastBackup: failed, lastSuccessfulBackup: completed });

    const label = screen.getByText(/backup.status.latestAttemptFailed/);
    expect(label).toHaveClass('text-danger-text');
    expect(label).toHaveTextContent(`at ${failed.created_at}`);
    expect(screen.getByText(/backup.status.lastSuccessfulBackup/)).toHaveTextContent(`at ${completed.created_at}`);
    expect(screen.queryByText(/backup.status.lastBackup:/)).not.toBeInTheDocument();
  });

  it('shows a running newest attempt in blue', async () => {
    await renderWithStatus({ lastBackup: running, lastSuccessfulBackup: completed });
    expect(screen.getByText(/backup.status.latestAttemptRunning/)).toHaveClass('text-info-text');
  });

  it('shows a completed newest attempt as the last backup, in green', async () => {
    await renderWithStatus({ lastBackup: completed, lastSuccessfulBackup: completed });
    const label = screen.getByText(/backup.status.lastBackup:/);
    expect(label.previousElementSibling).toHaveClass('text-success');
  });

  it('warns before a backup is started that an unusable signing key will fail it, with the reason', async () => {
    const reason = 'The backup manifest key file /data/backup-manifest.key is group- or world-writable (mode 0666)';
    await renderWithStatus({ lastBackup: completed, signingKey: { ready: false, source: 'invalid', keyId: null, reason } });
    expect(screen.getByText('backup.status.signingKeyInvalid')).toBeInTheDocument();
    expect(screen.getByText(reason)).toBeInTheDocument();
  });

  it('shows no key warning while the signing key is usable or not yet created', async () => {
    await renderWithStatus({ lastBackup: completed, signingKey: { ready: false, source: 'missing', keyId: null } });
    expect(screen.queryByText('backup.status.signingKeyInvalid')).not.toBeInTheDocument();
  });
});

// A restore started in this tab leaves a marker that sends the next sign-in
// back to its result. An account that cannot run restores cannot see that
// result, so the marker goes instead of steering every later sign-in here.
describe('BackupManagement and the restore re-login marker', () => {
  const MARKER = 'picpeak_restore_run';
  const setMarker = () => sessionStorage.setItem(MARKER,
    JSON.stringify({ startedAfter: '2026-11-20T10:00:00.000Z', since: Date.now(), redirected: true }));
  afterEach(() => { auth.role = 'super_admin'; sessionStorage.clear(); });

  it('drops the marker for an admin that may not restore', async () => {
    auth.role = 'admin';
    setMarker();
    await renderWithStatus({ lastBackup: completed });
    expect(sessionStorage.getItem(MARKER)).toBeNull();
  });

  it('keeps it for a Super Admin, whose restore tab shows the result', async () => {
    setMarker();
    await renderWithStatus({ lastBackup: completed });
    expect(sessionStorage.getItem(MARKER)).not.toBeNull();
  });
});
