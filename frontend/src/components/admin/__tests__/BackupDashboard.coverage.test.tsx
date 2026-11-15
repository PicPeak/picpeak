/**
 * The "Backup coverage" card read keys no backend run wrote, so it showed
 * "Database: Excluded, Photos: 0 of 0, Archives: 0 files" on every install.
 * Runs now record them; a run recorded before that says nothing either way
 * and must read as unknown, not as an excluded database and zero photos.
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { BackupDashboard } from '../BackupDashboard';

vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next');
  return { ...actual, useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }) };
});
vi.mock('../../../hooks/useLocalizedDate', () => ({
  useLocalizedDate: () => ({
    format: () => '2026-11-15',
    formatTime: () => '02:00',
    formatDateTime: () => '2026-11-15 02:00',
    formatDistanceToNow: () => '3 hours ago',
  }),
}));

const run = (statistics: Record<string, unknown>) => ({
  id: 7,
  status: 'completed' as const,
  backup_type: 'scheduled',
  created_at: '2026-11-15T02:00:00.000Z',
  started_at: '2026-11-15T02:00:00.000Z',
  duration_seconds: 42,
  statistics,
});

function renderCard(statistics: Record<string, unknown>) {
  const lastSuccessfulBackup = run(statistics);
  render(
    <BackupDashboard
      status={{ lastBackup: lastSuccessfulBackup, lastSuccessfulBackup, recentBackups: [], totalBackups: 1 }}
      config={{ backup_destination_type: 'rsync', backup_enabled: true, backup_rsync_host: 'u1.your-storagebox.de' }}
      onRunBackup={() => {}}
      isBackupRunning={false}
    />,
  );
  const card = screen.getByText('backup.dashboard.coverage.title').closest('div.p-6') as HTMLElement;
  const row = (label: string) => within(card).getByText(label).closest('div.justify-between') as HTMLElement;
  return {
    database: row('backup.configuration.whatToBackup.database'),
    photos: row('backup.configuration.whatToBackup.photos'),
    archives: row('backup.configuration.whatToBackup.archives'),
  };
}

describe('BackupDashboard — backup coverage card', () => {
  it('shows what the last run recorded', () => {
    const rows = renderCard({
      files_processed: 12, total_size: 1000,
      database_backed_up: true, photos_backed_up: 1180, total_photos: 1200, archives_backed_up: 4,
    });
    expect(within(rows.database).getByText('backup.dashboard.coverage.included')).toBeTruthy();
    expect(rows.photos.textContent).toContain('1180 common.of 1200');
    expect(rows.archives.textContent).toContain('4 backup.dashboard.stats.files');
  });

  it('shows a run without the database as excluded, and zero counts as zero', () => {
    const rows = renderCard({
      database_backed_up: false, photos_backed_up: 0, total_photos: 3, archives_backed_up: 0,
    });
    expect(within(rows.database).getByText('backup.dashboard.coverage.excluded')).toBeTruthy();
    expect(rows.photos.textContent).toContain('0 common.of 3');
    expect(rows.archives.textContent).toContain('0 backup.dashboard.stats.files');
  });

  it('shows a run recorded before these keys as unknown, not as excluded or 0 of 0', () => {
    const rows = renderCard({ files_processed: 12, total_size: 1000, per_path: { 'events/active': { count: 10, size: 900 } } });
    expect(within(rows.database).queryByText('backup.dashboard.coverage.excluded')).toBeNull();
    expect(within(rows.database).getByTitle('backup.dashboard.coverage.unknown').textContent).toBe('—');
    expect(rows.photos.textContent).not.toContain('0 common.of 0');
    expect(within(rows.photos).getByTitle('backup.dashboard.coverage.unknown').textContent).toBe('—');
    expect(within(rows.archives).getByTitle('backup.dashboard.coverage.unknown').textContent).toBe('—');
  });
});
