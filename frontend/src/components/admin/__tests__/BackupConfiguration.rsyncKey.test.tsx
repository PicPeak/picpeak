/**
 * The rsync backup hands backup_rsync_ssh_key to `ssh -i`: it is the path of
 * a key file. The form asked for the key itself, so pasted keys were saved
 * and every rsync backup failed. It now asks for a path and refuses a key.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { BackupConfiguration } from '../BackupConfiguration';

const { toastApi } = vi.hoisted(() => ({ toastApi: { success: vi.fn(), error: vi.fn() } }));
vi.mock('react-toastify', () => ({ toast: toastApi }));
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

const rsync = {
  backup_destination_type: 'rsync' as const,
  backup_rsync_host: 'backup.example.com',
  backup_rsync_user: 'picpeak',
  backup_rsync_path: '/srv/backups',
};

const renderForm = (sshKey: string) => {
  const onSave = vi.fn();
  render(<BackupConfiguration config={{ ...rsync, backup_rsync_ssh_key: sshKey }} onSave={onSave} isSaving={false} />);
  return onSave;
};
const save = () => userEvent.click(screen.getByRole('button', { name: /backup.configuration.saveSettings/ }));
const keyInput = () => screen.getByPlaceholderText('backup.configuration.fields.rsyncSshKeyPlaceholder');

describe('BackupConfiguration rsync SSH key', () => {
  beforeEach(() => Object.values(toastApi).forEach((fn) => fn.mockReset()));

  it('is a single-line path field', () => {
    renderForm('/app/data/ssh/backup_ed25519');
    expect(keyInput().tagName).toBe('INPUT');
    expect(keyInput()).toHaveValue('/app/data/ssh/backup_ed25519');
  });

  it('saves a key file path', async () => {
    const onSave = renderForm('/app/data/ssh/backup_ed25519');
    await save();
    expect(onSave.mock.calls[0][0]).toEqual(expect.objectContaining({ backup_rsync_ssh_key: '/app/data/ssh/backup_ed25519' }));
  });

  it('refuses a pasted key before saving', async () => {
    const onSave = renderForm('/app/data/ssh/backup_ed25519');
    await userEvent.clear(keyInput());
    await userEvent.type(keyInput(), '-----BEGIN OPENSSH PRIVATE KEY-----');
    await save();
    expect(onSave).not.toHaveBeenCalled();
    expect(toastApi.error).toHaveBeenCalledWith('backup.configuration.messages.rsyncSshKeyNotPath');
  });

  it('explains a stored pasted key and still lets the form save around it', async () => {
    const onSave = renderForm('••••••••');
    expect(screen.getByText('backup.configuration.fields.rsyncSshKeyStoredNotPath')).toBeInTheDocument();
    await save();
    expect(onSave).toHaveBeenCalledTimes(1);
  });
});
