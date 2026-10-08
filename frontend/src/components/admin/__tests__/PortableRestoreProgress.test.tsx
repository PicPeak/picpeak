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
vi.mock('react-i18next', async () => ({ ...await vi.importActual<typeof import('react-i18next')>('react-i18next'), useTranslation: () => ({ t: (key: string) => {
  const locale = state.language === 'de' ? de : en;
  const value = key.split('.').reduce<unknown>((acc, name) => acc && typeof acc === 'object'
    ? (acc as Record<string, unknown>)[name] : undefined, locale);
  return typeof value === 'string' ? value : key;
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
  it('reports recovery/verified rollback generically and never displays a raw server error', async () => {
    vi.mocked(portableBackupService.progress).mockResolvedValue({ ...progress, state: 'recovery_required', outcome: 'rolled_back',
      error: { message: 'SELECT secrets FROM /private/storage/archive' } } as RestoreProgress);
    render(<PortableRestoreProgress handle={handle} />);
    await act(async () => {});
    expect(screen.getByText(en.backup.picpeak.rollbackVerified)).toBeInTheDocument();
    expect(screen.getByText(en.backup.picpeak.recoveryRequired)).toBeInTheDocument();
    expect(screen.queryByText(/SELECT secrets/)).not.toBeInTheDocument();
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
