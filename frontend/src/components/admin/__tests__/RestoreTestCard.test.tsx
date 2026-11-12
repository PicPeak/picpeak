/**
 * Backup → Integrity → Restore test card: the newest result check by check,
 * a skip reason in plain words, and "Run restore test now" only for admins
 * holding backup.restore.
 */
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import en from '../../../i18n/locales/en.json';
import type { Verification, VerificationsResponse } from '../../../services/backupVerification.service';

const { get, post, hasPermission, toast } = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  hasPermission: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('../../../config/api', () => ({ api: { get, post } }));
vi.mock('react-toastify', () => ({ toast }));
vi.mock('../../../contexts/PermissionsContext', () => ({ usePermissions: () => ({ hasPermission }) }));
vi.mock('../../../hooks/useLocalizedDate', () => ({
  useLocalizedDate: () => ({
    formatDateTime: (value: string) => `at ${value}`,
    formatDistanceToNow: () => '3 hours ago',
  }),
}));
vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next');
  const lookup = (key: string): string | undefined => key.split('.').reduce<unknown>(
    (node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined),
    en,
  ) as string | undefined;
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string, fallback?: unknown, options?: Record<string, unknown>) => {
        const text = lookup(key) ?? `MISSING:${key}:${String(fallback)}`;
        return text.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(options?.[name] ?? ''));
      },
      i18n: { language: 'en' },
    }),
  };
});

import { RestoreTestCard } from '../RestoreTestCard';

const rt = en.backup.restoreTest;

const verification = (overrides: Partial<Verification> = {}): Verification => ({
  id: 1,
  backup_run_id: 42,
  database_backup_run_id: null,
  level: 'drill',
  status: 'passed',
  skip_reason: null,
  checks: [],
  full: false,
  sample_percent: 5,
  triggered_by: 'backup',
  triggered_by_admin_id: null,
  started_at: '2026-11-10T04:00:00Z',
  completed_at: '2026-11-10T04:05:00Z',
  ...overrides,
});

const response = (latest: Verification | null, overrides: Partial<VerificationsResponse> = {}): VerificationsResponse => ({
  items: latest ? [latest] : [],
  latest,
  lastPassedAt: latest?.status === 'passed' ? latest.completed_at : null,
  health: latest?.status === 'failed' ? 'failed' : latest ? 'ok' : 'none',
  staleDays: 14,
  running: false,
  byBackupRun: {},
  settings: { enabled: true, cron: '0 4 * * 0', samplePercent: 5 },
  ...overrides,
});

const renderCard = (data: VerificationsResponse) => {
  get.mockResolvedValue({ data });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><RestoreTestCard /></QueryClientProvider>);
};

beforeEach(() => {
  get.mockReset();
  post.mockReset();
  toast.success.mockReset();
  toast.error.mockReset();
  hasPermission.mockReset().mockImplementation((perm: string) => perm === 'backup.restore' || perm === 'backup.view');
});
afterEach(cleanup);

describe('RestoreTestCard', () => {
  it('shows a passed restore drill with its checks', async () => {
    renderCard(response(verification({
      checks: [
        { name: 'manifest_signature', result: 'passed' },
        { name: 'drill_row_counts', result: 'passed', detail: '128 tables match' },
        { name: 'some_future_check', result: 'skipped' },
      ],
    })));

    expect(await screen.findByText(rt.status.passed)).toBeInTheDocument();
    expect(screen.getByText(rt.level.drill)).toBeInTheDocument();
    expect(screen.getByText('Backup #42')).toBeInTheDocument();
    expect(screen.getByText(rt.trigger.backup)).toBeInTheDocument();
    expect(screen.getByText('3 hours ago')).toBeInTheDocument();
    expect(screen.getByText('at 2026-11-10T04:05:00Z')).toBeInTheDocument();
    expect(screen.getByText(rt.checks.manifest_signature)).toBeInTheDocument();
    expect(screen.getByText(rt.checks.drill_row_counts)).toBeInTheDocument();
    expect(screen.getByText('128 tables match')).toBeInTheDocument();
    // Unknown check names fall back to the raw key.
    expect(screen.getByText('some_future_check')).toBeInTheDocument();
  });

  it('shows a failed test and the failing check detail', async () => {
    renderCard(response(verification({
      status: 'failed',
      checks: [{ name: 'dump_checksum', result: 'failed', detail: 'sha256 mismatch' }],
    })));

    expect(await screen.findByText(rt.status.failed)).toBeInTheDocument();
    expect(screen.getByText(rt.checks.dump_checksum)).toBeInTheDocument();
    expect(screen.getByText('sha256 mismatch')).toBeInTheDocument();
  });

  it('explains an rsync backup is skipped in plain words', async () => {
    renderCard(response(verification({
      status: 'skipped', level: 'deep', skip_reason: 'not_verifiable_rsync',
    })));

    expect(await screen.findByText(rt.status.skipped)).toBeInTheDocument();
    expect(screen.getByText(rt.skipReasons.not_verifiable_rsync)).toBeInTheDocument();
    expect(screen.queryByText('not_verifiable_rsync')).not.toBeInTheDocument();
  });

  it('warns when no test passed within the stale window', async () => {
    renderCard(response(verification({ status: 'failed' }), { health: 'stale' }));

    expect(await screen.findByText('No passed restore test in the last 14 days')).toBeInTheDocument();
  });

  it('hides the run buttons without backup.restore', async () => {
    hasPermission.mockImplementation((perm: string) => perm === 'backup.view');
    renderCard(response(verification()));

    await screen.findByText(rt.status.passed);
    expect(screen.queryByRole('button', { name: rt.runNow })).not.toBeInTheDocument();
    expect(screen.queryByLabelText(rt.hashAll)).not.toBeInTheDocument();
  });

  it('renders nothing and asks for nothing without backup.view', async () => {
    hasPermission.mockReturnValue(false);
    const { container } = render(<QueryClientProvider client={new QueryClient()}><RestoreTestCard /></QueryClientProvider>);
    expect(container).toBeEmptyDOMElement();
    expect(get).not.toHaveBeenCalled();
  });

  it('starts a test, with every file hashed when asked', async () => {
    post.mockResolvedValue({ data: { id: 9 } });
    renderCard(response(verification()));

    await userEvent.click(await screen.findByLabelText(rt.hashAll));
    await userEvent.click(screen.getByRole('button', { name: rt.runNow }));

    expect(post).toHaveBeenCalledWith('/admin/backup/verifications', { full: true });
    expect(toast.success).toHaveBeenCalledWith(rt.started);
  });

  it('says so when something else is running', async () => {
    post.mockRejectedValue({ response: { status: 409, data: { error: 'busy', code: 'VERIFICATION_BUSY' } } });
    renderCard(response(verification()));

    await userEvent.click(await screen.findByRole('button', { name: rt.runNow }));

    expect(post).toHaveBeenCalledWith('/admin/backup/verifications', {});
    expect(toast.error).toHaveBeenCalledWith(rt.busy);
  });

  it('disables the button while a test is running', async () => {
    renderCard(response(verification({ status: 'running', completed_at: null }), { running: true, health: 'running' }));

    expect(await screen.findByText(rt.status.running)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: rt.runNow })).toBeDisabled();
  });
});
