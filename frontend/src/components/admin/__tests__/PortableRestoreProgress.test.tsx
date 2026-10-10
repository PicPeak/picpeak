import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import en from '../../../i18n/locales/en.json';
import de from '../../../i18n/locales/de.json';
import { portableBackupService, type RestoreProgress } from '../../../services/portableBackup.service';
import { PortableRestoreProgress } from '../PortableRestoreProgress';

const state = vi.hoisted(() => ({ language: 'en' }));
vi.mock('../../../services/portableBackup.service', () => ({
  portableBackupService: { progress: vi.fn() }, clearRestoreHandle: vi.fn(),
}));
vi.mock('react-i18next', async () => ({ ...await vi.importActual<typeof import('react-i18next')>('react-i18next'), useTranslation: () => ({ t: (key: string, options?: Record<string, unknown>) => {
  const locale = state.language === 'de' ? de : en;
  const value = key.split('.').reduce<unknown>((acc, name) => acc && typeof acc === 'object'
    ? (acc as Record<string, unknown>)[name] : undefined, locale);
  const text = typeof value === 'string' ? value : (typeof options?.defaultValue === 'string' ? options.defaultValue : key);
  return text.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(options?.[name] ?? ''));
} }) }));
const handle = { attemptId: '01234567-89ab-4cde-8123-456789abcdef', progressToken: 'a'.repeat(64) };
const progress: RestoreProgress = { attemptId: handle.attemptId, state: 'restart_required', outcome: 'committed',
  restartRequired: true, complete: false, summary: { tables: 3, filesRestored: 7 } };

describe('session-independent coordinated restore progress', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.clearAllMocks(); state.language = 'en'; });
  afterEach(() => { vi.useRealTimers(); });
  it.each(['en', 'de'])('retains the restart barrier and translated result in %s without an admin session', async language => {
    state.language = language;
    vi.mocked(portableBackupService.progress).mockResolvedValue(progress);
    render(<PortableRestoreProgress handle={handle} />);
    await act(async () => {});
    const locale = language === 'de' ? de : en;
    expect(screen.getByText(locale.backup.picpeak.restartAllInstances)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: locale.backup.picpeak.returnToLogin })).not.toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    expect(portableBackupService.progress).toHaveBeenCalledTimes(2);
  });
  it('retries network loss instead of presenting unproved completion or leaving the progress panel', async () => {
    vi.mocked(portableBackupService.progress).mockRejectedValueOnce(new Error('socket closed')).mockResolvedValue(progress);
    render(<PortableRestoreProgress handle={handle} />);
    await act(async () => {});
    expect(screen.getByText(en.backup.picpeak.progressUnavailable)).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(screen.queryByText(en.backup.picpeak.progressUnavailable)).not.toBeInTheDocument();
    expect(screen.getByText(en.backup.picpeak.restartAllInstances)).toBeInTheDocument();
  });
  it.each(['en', 'de'])('after a verified rollback says in %s that the instance runs again, why it failed, and needs no login', async language => {
    state.language = language;
    const locale = language === 'de' ? de : en;
    vi.mocked(portableBackupService.progress).mockResolvedValue({ ...progress, state: 'open', outcome: 'rolled_back',
      restartRequired: false, complete: true, summary: {},
      error: { code: 'RESTORE_TABLE_CHECKSUM', statusCode: 400, message: 'The backup\'s "photos" table does not match its recorded checksum' } });
    render(<PortableRestoreProgress handle={handle} />);
    await act(async () => {});
    expect(screen.getByText(locale.backup.picpeak.rollbackVerified)).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(locale.backup.picpeak.restoreError.RESTORE_TABLE_CHECKSUM);
    expect(screen.queryByText(locale.backup.picpeak.restartAllInstances)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: locale.backup.picpeak.backToBackup })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: locale.backup.picpeak.returnToLogin })).not.toBeInTheDocument();
  });
  it('shows the server\'s own reason for a failure code it has no translation for, and an aborted drain as such', async () => {
    vi.mocked(portableBackupService.progress).mockResolvedValue({ ...progress, state: 'open', outcome: 'aborted',
      restartRequired: false, complete: true, summary: {},
      error: { code: 'SOME_NEW_CODE', statusCode: 500, message: 'The worker ran out of disk space' } });
    render(<PortableRestoreProgress handle={handle} />);
    await act(async () => {});
    expect(screen.getByText(en.backup.picpeak.restoreAborted)).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('The worker ran out of disk space');
  });
  it('keeps showing an interrupted restore as being recovered, with its reason', async () => {
    vi.mocked(portableBackupService.progress).mockResolvedValue({ ...progress, state: 'recovery_required', outcome: 'recovery_required',
      restartRequired: false, error: { code: 'RESTORE_DRAIN_TIMEOUT', statusCode: 503, message: 'raw' } });
    render(<PortableRestoreProgress handle={handle} />);
    await act(async () => {});
    expect(screen.getByText(en.backup.picpeak.recoveryRequired)).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(en.backup.picpeak.restoreError.RESTORE_DRAIN_TIMEOUT);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
  it('ends polling only on exact denied capability or coordinated completion', async () => {
    vi.mocked(portableBackupService.progress).mockRejectedValue({ response: { status: 404 } });
    const view = render(<PortableRestoreProgress handle={handle} />);
    await act(async () => {});
    expect(screen.getByText(en.backup.picpeak.progressDenied)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: en.backup.picpeak.returnToLogin })).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
    expect(portableBackupService.progress).toHaveBeenCalledTimes(1);
    view.unmount();
    vi.mocked(portableBackupService.progress).mockResolvedValue({ ...progress, state: 'open', complete: true, restartRequired: false });
    render(<PortableRestoreProgress handle={handle} />); await act(async () => {});
    await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
    expect(portableBackupService.progress).toHaveBeenCalledTimes(2);
  });
  it('aborts its request and timer when the panel unmounts', async () => {
    vi.mocked(portableBackupService.progress).mockResolvedValue(progress);
    const view = render(<PortableRestoreProgress handle={handle} />); await act(async () => {});
    const signal = vi.mocked(portableBackupService.progress).mock.calls[0][1]!;
    view.unmount(); expect(signal.aborted).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
    expect(portableBackupService.progress).toHaveBeenCalledTimes(1);
  });
});
