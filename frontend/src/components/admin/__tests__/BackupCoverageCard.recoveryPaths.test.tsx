import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import en from '../../../i18n/locales/en.json';
import de from '../../../i18n/locales/de.json';
import { BackupCoverageCard } from '../BackupCoverageCard';

const state = vi.hoisted(() => ({ language: 'en', custom: false }));
vi.mock('react-i18next', async () => ({
  ...await vi.importActual<typeof import('react-i18next')>('react-i18next'),
  useTranslation: () => ({
    t: (key: string, fallback?: unknown) => {
      const locale = state.language === 'de' ? de : en;
      const value = key.split('.').reduce<unknown>((acc, name) =>
        acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[name] : undefined, locale);
      return typeof value === 'string' ? value : typeof fallback === 'string' ? fallback : key;
    },
  }),
}));
vi.mock('../../../hooks/useLocalizedDate', () => ({ useLocalizedDate: () => ({ formatDateTime: () => 'date' }) }));
vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: {
    generatedAt: '2026-10-07T19:00:00Z', database: { ok: true, mode: 'inline' },
    summary: { overallOk: true, databaseOk: true, willScanCount: 2, configuredCount: 2, driftCount: 0 },
    drift: { unconfiguredOnDisk: [] }, paths: [
      { path: 'transfers', description: state.custom ? 'Operator description' : 'Admin deliverable transfer attachments', coverage: 'will-scan' },
      { path: 'watermarks', description: 'Managed watermarked gallery renditions', coverage: 'will-scan' },
    ],
  }, refetch: vi.fn() }),
}));

describe('new recovery-path descriptions', () => {
  it.each(['en', 'de'])('renders the seeded descriptions in %s', language => {
    state.language = language; state.custom = false;
    render(<BackupCoverageCard />);
    const locale = language === 'de' ? de : en;
    expect(screen.getByText(locale.backup.coverage.paths.transferDescription)).toBeInTheDocument();
    expect(screen.getByText(locale.backup.coverage.paths.watermarkDescription)).toBeInTheDocument();
  });

  it('preserves an operator-edited description', () => {
    state.language = 'de'; state.custom = true;
    render(<BackupCoverageCard />);
    expect(screen.getByText('Operator description')).toBeInTheDocument();
  });
});
