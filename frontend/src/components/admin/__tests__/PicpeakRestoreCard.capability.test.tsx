import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import en from '../../../i18n/locales/en.json';
import de from '../../../i18n/locales/de.json';
import { portableBackupService } from '../../../services/portableBackup.service';
import { PicpeakRestoreCard } from '../PicpeakBackupCard';

const state = vi.hoisted(() => ({ language: 'en' }));
vi.mock('../../../services/portableBackup.service', () => ({
  portableBackupService: { capability: vi.fn(), start: vi.fn() },
}));
vi.mock('react-i18next', async () => ({ ...await vi.importActual<typeof import('react-i18next')>('react-i18next'), useTranslation: () => ({ t: (key: string, fallback?: string | Record<string, unknown>) => {
  const locale = state.language === 'de' ? de : en;
  const value = key.split('.').reduce<unknown>((acc, name) => acc && typeof acc === 'object'
    ? (acc as Record<string, unknown>)[name] : undefined, locale);
  if (typeof value === 'string') return value;
  if (typeof fallback === 'string') return fallback;
  return typeof fallback?.defaultValue === 'string' ? fallback.defaultValue : key;
} }) }));

const renderCard = () => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <PicpeakRestoreCard />
  </QueryClientProvider>,
);
const off = (reason: string, message: string) => ({ available: false, reason, message, maintenance: false, restartRequired: false });

describe('restore card on a server that cannot run a portable restore', () => {
  beforeEach(() => { vi.clearAllMocks(); state.language = 'en'; });

  it.each(['en', 'de'])('shows the feature as unavailable with the reason in %s and disables the upload', async language => {
    state.language = language;
    const locale = language === 'de' ? de : en;
    vi.mocked(portableBackupService.capability).mockResolvedValue(off('RESTORE_STORAGE_UNSUPPORTED', 'Portable restore needs STORAGE_PATH on a local filesystem'));
    renderCard();
    await waitFor(() => expect(screen.getByRole('status')).toBeInTheDocument());
    expect(screen.getByText(locale.backup.picpeak.unavailableTitle)).toBeInTheDocument();
    expect(screen.getByText(locale.backup.picpeak.unavailable.RESTORE_STORAGE_UNSUPPORTED)).toBeInTheDocument();
    expect(screen.getByText(locale.backup.picpeak.unavailableHelp)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: locale.backup.picpeak.chooseFile })).toBeDisabled();
  });

  it('falls back to the server text for a reason it has no translation for', async () => {
    vi.mocked(portableBackupService.capability).mockResolvedValue(off('RESTORE_SOMETHING_NEW', 'A requirement added later is missing'));
    renderCard();
    await waitFor(() => expect(screen.getByText('A requirement added later is missing')).toBeInTheDocument());
  });

  it('offers the upload where the server can restore, and while the answer is still unknown', async () => {
    vi.mocked(portableBackupService.capability).mockResolvedValue({ available: true, reason: null, message: null, maintenance: false, restartRequired: false });
    renderCard();
    await waitFor(() => expect(portableBackupService.capability).toHaveBeenCalled());
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: en.backup.picpeak.chooseFile })).toBeEnabled();
  });

  it('has every reason and failure code the server can send in both languages', () => {
    for (const locale of [en, de]) {
      for (const reason of ['RESTORE_UNSUPPORTED_PLATFORM', 'RESTORE_LEASE_UNAVAILABLE', 'RESTORE_GUARD_UNAVAILABLE', 'RESTORE_STORAGE_UNSUPPORTED']) {
        expect((locale.backup.picpeak.unavailable as Record<string, string>)[reason]).toEqual(expect.any(String));
      }
      for (const code of ['RESTORE_MANIFEST_INVALID', 'RESTORE_PRIVILEGE_MISSING', 'RESTORE_CAPACITY_LIMIT', 'RESTORE_ARCHIVE_LIMIT',
        'PORTABLE_ARCHIVE_REFUSED', 'RESTORE_TABLE_CHECKSUM', 'RESTORE_DRAIN_TIMEOUT', 'RESTORE_ROLLED_BACK']) {
        expect((locale.backup.picpeak.restoreError as Record<string, string>)[code]).toEqual(expect.any(String));
      }
    }
  });
});
