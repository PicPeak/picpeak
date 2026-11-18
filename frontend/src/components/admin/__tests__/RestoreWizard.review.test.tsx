/**
 * Restore wizard review step and result: the pre-flight warnings are listed
 * (with what each one means) before the restore is started, the start button
 * waits for the admin to override them, and a restore stopped in pre-flight
 * says nothing was changed.
 */
import { render, screen, cleanup, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import en from '../../../i18n/locales/en.json';

const { get, post, toast } = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('../../../config/api', () => ({ api: { get, post } }));
vi.mock('react-toastify', () => ({ toast }));
vi.mock('../PicpeakBackupCard', () => ({ PicpeakRestoreCard: () => null }));
vi.mock('../../../hooks/useLocalizedDate', () => ({
  useLocalizedDate: () => ({
    format: () => 'BACKUP-DAY',
    formatTime: () => '10:00',
    formatDateTime: (value: string) => `at ${value}`,
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
      t: (key: string, fallbackOrOptions?: unknown, maybeOptions?: Record<string, unknown>) => {
        const options = (typeof fallbackOrOptions === 'object' ? fallbackOrOptions : maybeOptions) as
          Record<string, unknown> | undefined;
        const text = lookup(key);
        if (typeof text !== 'string') return `MISSING:${key}`;
        return text.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(options?.[name] ?? ''));
      },
      i18n: { language: 'en' },
    }),
  };
});

import { RestoreWizard } from '../RestoreWizard';

const r = en.backup.restore;
const notices = r.confirmation.notices;

type Validation = {
  isValid: boolean;
  errors: string[];
  warnings: string[];
  notices?: Array<{ severity: string; code: string | null; message: string; params?: Record<string, unknown> }>;
};

// What the user's beta install returned for a full backup of an older beta
// onto an install with 4 events, once the version is only an info line.
const userCase: Validation = {
  isValid: true,
  errors: [],
  warnings: [
    'Database contains 4 existing events that will be overwritten',
    'There are 1 active admin users',
  ],
  notices: [
    { severity: 'info', code: 'version_older', message: 'Backup from v3.202.2-beta.0 will be migrated',
      params: { backupVersion: '3.202.2-beta.0', currentVersion: '3.204.0-beta.0' } },
    { severity: 'warning', code: 'existing_events', message: 'Database contains 4 existing events that will be overwritten',
      params: { count: 4 } },
    { severity: 'warning', code: 'active_admins', message: 'There are 1 active admin users', params: { count: 1 } },
  ],
};

const clean: Validation = { isValid: true, errors: [], warnings: [], notices: [] };

const mockBackend = ({ validation, history = [], settings = { restore_allow_force: true } }: {
  validation: Validation;
  history?: Array<Record<string, unknown>>;
  settings?: Record<string, unknown>;
}) => {
  get.mockImplementation(async (url: string) => {
    if (url === '/admin/restore/status') {
      return { data: { data: { isRunning: false, currentProgress: null, history, settings } } };
    }
    throw new Error(`unexpected GET ${url}`);
  });
  post.mockImplementation(async (url: string) => {
    if (url === '/admin/restore/list-backups') {
      return { data: { data: [{ id: 'm1', manifest_path: '/backups/m1.json', created_at: '2026-11-01T10:00:00Z',
        backup_type: 'full', total_size: 1024, database_included: true }] } };
    }
    if (url === '/admin/restore/validate') return { data: { data: { validation, spaceCheck: null } } };
    if (url === '/admin/restore/start') return { data: { success: true } };
    throw new Error(`unexpected POST ${url}`);
  });
};

const renderWizard = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <RestoreWizard />
    </QueryClientProvider>,
  );
};

const user = () => userEvent.setup();

// Source → backup → options → review.
const goToReview = async (u: ReturnType<typeof userEvent.setup>) => {
  await u.click(screen.getByText(r.source.local.name));
  await u.click(screen.getByRole('button', { name: new RegExp(r.actions.next) }));
  await u.click(await screen.findByText(/BACKUP-DAY/));
  await u.click(screen.getByRole('button', { name: new RegExp(r.actions.next) }));
  await u.click(screen.getByRole('button', { name: new RegExp(r.actions.next) }));
  await screen.findByRole('heading', { name: r.confirmation.title });
};

const startButton = () => screen.getByRole('button', { name: new RegExp(r.actions.startRestore) });

describe('RestoreWizard review step', () => {
  beforeEach(() => {
    get.mockReset();
    post.mockReset();
  });
  afterEach(cleanup);

  it('lists each warning with its explanation and the version as an info line', async () => {
    mockBackend({ validation: userCase });
    const u = user();
    renderWizard();
    await goToReview(u);

    expect(screen.getByText(r.confirmation.validation.passedWithWarnings)).toBeTruthy();
    expect(screen.queryByText(r.confirmation.validation.passed)).toBeNull();
    const list = screen.getByRole('list', { name: notices.warningsLabel });
    expect(within(list).getByText('4 existing events will be replaced')).toBeTruthy();
    expect(within(list).getByText(notices.existing_events.help)).toBeTruthy();
    expect(within(list).getByText('This install has 1 active admin accounts')).toBeTruthy();
    expect(within(list).queryByText(/3\.202\.2/)).toBeNull();
    expect(screen.getByText('Backup from v3.202.2-beta.0.')).toBeTruthy();
  });

  it('falls back to the plain message for a warning without a known code', async () => {
    mockBackend({ validation: { isValid: true, errors: [], warnings: ['Something new the backend says'] } });
    const u = user();
    renderWizard();
    await goToReview(u);

    const list = screen.getByRole('list', { name: notices.warningsLabel });
    expect(within(list).getByText('Something new the backend says')).toBeTruthy();
    expect(within(list).getByText(notices.generic.help)).toBeTruthy();
  });

  it('only starts after the warnings are acknowledged, and then sends force', async () => {
    mockBackend({ validation: userCase });
    const u = user();
    renderWizard();
    await goToReview(u);

    expect((startButton() as HTMLButtonElement).disabled).toBe(true);
    await u.click(startButton());
    expect(post).not.toHaveBeenCalledWith('/admin/restore/start', expect.anything());

    await u.click(screen.getByLabelText(new RegExp(r.confirmation.acknowledge.label)));
    expect((startButton() as HTMLButtonElement).disabled).toBe(false);
    await u.click(startButton());
    expect(post).toHaveBeenCalledWith('/admin/restore/start', expect.objectContaining({ force: true }));
  });

  it('a clean validation needs no acknowledgement and does not send force', async () => {
    mockBackend({ validation: clean });
    const u = user();
    renderWizard();
    await goToReview(u);

    expect(screen.getByText(r.confirmation.validation.passed)).toBeTruthy();
    expect(screen.queryByLabelText(new RegExp(r.confirmation.acknowledge.label))).toBeNull();
    await u.click(startButton());
    expect(post).toHaveBeenCalledWith('/admin/restore/start', expect.objectContaining({ force: false }));
  });

  it('the options step no longer carries a second force control', async () => {
    mockBackend({ validation: clean });
    const u = user();
    renderWizard();
    await u.click(screen.getByText(r.source.local.name));
    await u.click(screen.getByRole('button', { name: new RegExp(r.actions.next) }));
    await u.click(await screen.findByText(/BACKUP-DAY/));
    await u.click(screen.getByRole('button', { name: new RegExp(r.actions.next) }));

    expect(screen.getByText(r.options.additionalOptions.skipPreBackup)).toBeTruthy();
    expect(screen.queryByText(r.options.additionalOptions.force)).toBeNull();
  });

  it('cannot start when the server does not allow overriding warnings', async () => {
    mockBackend({ validation: userCase, settings: { restore_allow_force: false } });
    const u = user();
    renderWizard();
    await goToReview(u);

    expect(screen.getByText(r.confirmation.acknowledge.forceDisabled)).toBeTruthy();
    expect((screen.getByLabelText(new RegExp(r.confirmation.acknowledge.label)) as HTMLInputElement).disabled).toBe(true);
    expect((startButton() as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('RestoreWizard result', () => {
  beforeEach(() => {
    get.mockReset();
    post.mockReset();
  });
  afterEach(cleanup);

  const reachResult = async (lastRun: Record<string, unknown>) => {
    mockBackend({ validation: clean, history: [lastRun] });
    const u = user();
    renderWizard();
    await goToReview(u);
    await u.click(startButton());
    await screen.findByRole('heading', { name: r.progress.title });
  };

  it('a restore stopped in pre-flight says nothing was changed', async () => {
    await reachResult({
      id: 7, status: 'blocked', was_successful: 0, was_rollback_attempted: 0,
      error_message: 'Restore blocked due to warnings (use force to override): x (stopped before any change — this install was not modified)',
    });

    expect(screen.getByText(r.progress.blockedSubtitle)).toBeTruthy();
    expect(screen.getByText(r.progress.blockedTitle)).toBeTruthy();
    expect(screen.queryByText(r.progress.failedSubtitle)).toBeNull();
  });

  it('a failed run with a numeric 0 rollback flag (SQLite) renders no stray 0', async () => {
    await reachResult({
      id: 8, status: 'failed', was_successful: 0, was_rollback_attempted: 0, error_message: 'pg_restore exploded',
    });

    expect(screen.getByText(r.progress.failedSubtitle)).toBeTruthy();
    // The error box holds its title and the message, nothing else.
    const errorBox = screen.getByText('pg_restore exploded').parentElement as HTMLElement;
    expect(errorBox.textContent).toBe(`${r.progress.errorTitle}pg_restore exploded`);
    expect(screen.queryByText(r.progress.rolledBack)).toBeNull();
  });

  it('a succeeded run stored with SQLite 1/0 flags shows the success banner', async () => {
    await reachResult({ id: 9, status: 'completed', was_successful: 1, was_rollback_attempted: 0 });

    expect(screen.getByText(r.progress.success.title)).toBeTruthy();
  });
});

describe('RestoreWizard restore points on the rsync destination', () => {
  beforeEach(() => {
    get.mockReset();
    post.mockReset();
  });
  afterEach(cleanup);

  const remotePoint = { id: 'rsync:manifests/backup-manifest-b1.json', type: 'rsync', restore_source: 'rsync',
    manifest_path: 'rsync:manifests/backup-manifest-b1.json', created_at: '2026-11-01T10:00:00Z',
    backup_type: 'full', total_size: 2048, database_included: true };

  it('marks a remote point and validates and starts it with the rsync source', async () => {
    mockBackend({ validation: clean });
    const fallback = post.getMockImplementation();
    post.mockImplementation(async (url: string, body: unknown) => (url === '/admin/restore/list-backups'
      ? { data: { data: [remotePoint], remoteError: null } } : fallback?.(url, body)));
    const u = user();
    renderWizard();
    await goToReview(u);

    expect(post).toHaveBeenCalledWith('/admin/restore/validate', expect.objectContaining({
      source: 'rsync', manifestPath: remotePoint.manifest_path }));
    await u.click(startButton());
    expect(post).toHaveBeenCalledWith('/admin/restore/start', expect.objectContaining({
      source: 'rsync', manifestPath: remotePoint.manifest_path }));
  });

  it('shows the remote badge, and says when the destination could not be read', async () => {
    mockBackend({ validation: clean });
    post.mockImplementation(async () => ({ data: { data: [remotePoint],
      remoteError: { code: 'RSYNC_AUTH_FAILED', message: 'RSYNC_AUTH_FAILED: The destination refused the SSH login.' } } }));
    const u = user();
    renderWizard();
    await u.click(screen.getByText(r.source.local.name));
    await u.click(screen.getByRole('button', { name: new RegExp(r.actions.next) }));

    expect(await screen.findByText(r.backup.remoteBadge)).toBeTruthy();
    expect(screen.getByText(r.backup.remoteUnavailable.title)).toBeTruthy();
    expect(screen.getByText(/RSYNC_AUTH_FAILED: The destination refused the SSH login\./)).toBeTruthy();
    expect(screen.getByText(en.backup.errors.RSYNC_AUTH_FAILED)).toBeTruthy();
  });
});
