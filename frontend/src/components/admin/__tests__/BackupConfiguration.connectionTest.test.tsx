/**
 * Issue 1641: "Test connection" used to wait two seconds and report success
 * whatever was entered. It now asks the backend and shows its answer, and a
 * private S3 endpoint can be approved by a Super Admin from the form.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { BackupConfiguration } from '../BackupConfiguration';

const { post, toastApi } = vi.hoisted(() => ({
  post: vi.fn(),
  toastApi: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

vi.mock('../../../config/api', () => ({ api: { post } }));
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

const s3Config = {
  backup_destination_type: 's3' as const,
  backup_s3_endpoint: 'http://rustfs.lan:9000',
  backup_s3_bucket: 'backups',
  backup_s3_access_key: 'key',
  backup_s3_secret_key: '••••••••',
  backup_s3_region: 'us-east-1',
};

const renderForm = (config: Record<string, unknown> = s3Config, privateEndpointOrigin: string | null = null) => {
  const onSave = vi.fn();
  render(
    <BackupConfiguration
      config={config}
      onSave={onSave}
      isSaving={false}
      privateEndpointOrigin={privateEndpointOrigin}
    />,
  );
  return onSave;
};

const testButton = () => screen.getByRole('button', { name: /backup.actions.testConnection/ });
const saveButton = () => screen.getByRole('button', { name: /backup.configuration.saveSettings/ });

describe('BackupConfiguration connection test', () => {
  beforeEach(() => {
    post.mockReset();
    Object.values(toastApi).forEach((fn) => fn.mockReset());
  });

  it('calls the backend with the S3 form values', async () => {
    post.mockResolvedValue({ data: { success: true } });
    renderForm();

    await userEvent.click(testButton());

    expect(post).toHaveBeenCalledWith('/admin/backup/test-connection', expect.objectContaining({
      destination_type: 's3',
      endpoint: 'http://rustfs.lan:9000',
      bucket: 'backups',
      access_key: 'key',
      secret_key: '••••••••',
    }));
    await waitFor(() => expect(toastApi.success).toHaveBeenCalledWith('backup.configuration.messages.connectionSuccess'));
  });

  it('reports a failed test instead of success', async () => {
    post.mockResolvedValue({ data: { success: false, code: 'S3_CONNECTION_FAILED', message: 'nope' } });
    renderForm();

    await userEvent.click(testButton());

    await waitFor(() => expect(toastApi.error).toHaveBeenCalledWith(
      'backup.configuration.messages.connectionFailed: backup.errors.S3_CONNECTION_FAILED',
    ));
    expect(toastApi.success).not.toHaveBeenCalled();
  });

  it('asks for approval of a private endpoint and sends it with the next test and save', async () => {
    post.mockResolvedValueOnce({
      data: { success: false, code: 'S3_PRIVATE_ENDPOINT', origin: 'http://rustfs.lan:9000' },
    });
    const onSave = renderForm();

    await userEvent.click(testButton());
    expect(await screen.findByRole('alert')).toHaveTextContent('http://rustfs.lan:9000');
    expect(toastApi.warning).toHaveBeenCalledWith('backup.errors.S3_PRIVATE_ENDPOINT');

    await userEvent.click(screen.getByRole('checkbox', { name: /privateEndpoint.approve/ }));
    post.mockResolvedValueOnce({ data: { success: true } });
    await userEvent.click(testButton());
    expect(post).toHaveBeenLastCalledWith('/admin/backup/test-connection', expect.objectContaining({
      private_endpoint_approval: 'http://rustfs.lan:9000',
    }));

    await userEvent.click(saveButton());
    expect(onSave.mock.calls[0][0]).toEqual(expect.objectContaining({
      backup_s3_private_endpoint_approval: 'http://rustfs.lan:9000',
    }));
  });

  it('shows the approval for a save the backend refused, and drops it when the endpoint changes', async () => {
    renderForm(s3Config, 'http://rustfs.lan:9000');
    expect(screen.getByRole('alert')).toHaveTextContent('http://rustfs.lan:9000');

    await userEvent.type(screen.getByDisplayValue('http://rustfs.lan:9000'), '1');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('does not echo a stored approval back unless it is approved again', async () => {
    const onSave = renderForm({ ...s3Config, backup_s3_private_endpoint_approval: 'http://rustfs.lan:9000' });

    await userEvent.click(saveButton());

    expect(onSave.mock.calls[0][0]).not.toHaveProperty('backup_s3_private_endpoint_approval');
  });
});

describe('BackupConfiguration rsync connection test', () => {
  const rsync = {
    backup_destination_type: 'rsync' as const,
    backup_rsync_host: 'backup.example.com',
    backup_rsync_user: 'picpeak',
    backup_rsync_path: '/srv/backups',
  };

  beforeEach(() => post.mockReset().mockResolvedValue({ data: { success: true } }));

  it('sends a typed key file path', async () => {
    renderForm({ ...rsync, backup_rsync_ssh_key: '/app/data/ssh/backup_ed25519' });
    await userEvent.click(testButton());
    expect(post).toHaveBeenCalledWith('/admin/backup/test-connection', expect.objectContaining({
      destination_type: 'rsync', ssh_key: '/app/data/ssh/backup_ed25519',
    }));
  });

  it('leaves the mask out so the saved value is used', async () => {
    renderForm({ ...rsync, backup_rsync_ssh_key: '••••••••' });
    await userEvent.click(testButton());
    expect(post.mock.calls[0][1]).not.toHaveProperty('ssh_key');
  });
});

describe('automatic-backup switch', () => {
  it('colours the track with a defined token when on', () => {
    renderForm();
    const track = screen.getByRole('checkbox', { name: '' }).nextElementSibling as HTMLElement;
    expect(track.className).toContain('peer-checked:bg-primary-600');
    expect(track.className).not.toMatch(/peer-checked:bg-primary(\s|$)/);
  });
});
