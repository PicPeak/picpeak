/**
 * Only a Super Admin may change where backups go or whether they include the
 * database; the backend refuses it for everyone else. For other roles the
 * form shows why those fields are locked and leaves them out of the save, so
 * saving the schedule still works.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { BackupConfiguration } from '../BackupConfiguration';

vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next');
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string, fallback?: unknown) => (typeof fallback === 'string' ? fallback : key),
      i18n: { language: 'en' },
    }),
  };
});

const config = {
  backup_destination_type: 'local' as const,
  backup_destination_path: '/srv/backups',
  backup_retention_days: 30,
};

const renderForm = (canManageDestination?: boolean) => {
  const onSave = vi.fn();
  render(
    <BackupConfiguration config={config} onSave={onSave} isSaving={false} canManageDestination={canManageDestination} />,
  );
  return onSave;
};

describe('BackupConfiguration destination permission', () => {
  it('locks the destination for other roles and leaves it out of the save', async () => {
    const onSave = renderForm(false);

    expect(screen.getByText(/Only a Super Admin can change where backups are stored/)).toBeInTheDocument();
    expect(screen.getByDisplayValue('/srv/backups')).toBeDisabled();

    await userEvent.click(screen.getByRole('button', { name: /backup.configuration.saveSettings/ }));

    expect(onSave).toHaveBeenCalledTimes(1);
    const saved = onSave.mock.calls[0][0];
    expect(saved).toEqual(expect.objectContaining({ backup_retention_days: 30 }));
    expect(Object.keys(saved).filter((key) => /^backup_(destination_|s3_|rsync_)|^backup_include_database$/.test(key))).toEqual([]);
  });

  it('keeps the destination editable and saved for a Super Admin', async () => {
    const onSave = renderForm();

    expect(screen.queryByText(/Only a Super Admin can change where backups are stored/)).not.toBeInTheDocument();
    expect(screen.getByDisplayValue('/srv/backups')).toBeEnabled();

    await userEvent.click(screen.getByRole('button', { name: /backup.configuration.saveSettings/ }));

    expect(onSave.mock.calls[0][0]).toEqual(expect.objectContaining({ backup_destination_path: '/srv/backups' }));
  });
});
