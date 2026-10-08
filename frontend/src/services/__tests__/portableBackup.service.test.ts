import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../config/api';
import { clearRestoreHandle, portableBackupService, readRestoreHandle, RESTORE_HANDLE_EVENT } from '../portableBackup.service';

vi.mock('../../config/api', () => ({ api: { get: vi.fn(), post: vi.fn() } }));
const handle = { attemptId: '01234567-89ab-4cde-8123-456789abcdef', progressToken: 'a'.repeat(64) };

describe('coordinated portable backup service', () => {
  beforeEach(() => { vi.clearAllMocks(); sessionStorage.clear(); });
  it('exports through the service and admits only one multipart archive with no caller options', async () => {
    vi.mocked(api.post).mockResolvedValue({ data: handle });
    const listener = vi.fn(); window.addEventListener(RESTORE_HANDLE_EVENT, listener);
    const file = new File(['complete archive'], 'backup.picpeak');
    expect(await portableBackupService.start(file)).toEqual(handle);
    const [url, data] = vi.mocked(api.post).mock.calls[0];
    expect(url).toBe('/admin/backup/picpeak/import');
    expect(Array.from((data as FormData).keys())).toEqual(['backup']);
    expect((data as FormData).get('backup')).toBe(file);
    expect(readRestoreHandle()).toEqual(handle);
    expect(listener).toHaveBeenCalledTimes(1);
    portableBackupService.export(true);
    expect(api.get).toHaveBeenCalledWith('/admin/backup/picpeak/export', { params: { includePhotos: true }, responseType: 'blob' });
    window.removeEventListener(RESTORE_HANDLE_EVENT, listener);
  });
  it('uses the attempt-specific read-only capability header, not a broad auth or query bypass', async () => {
    vi.mocked(api.get).mockResolvedValue({ data: { state: 'restoring' } });
    const controller = new AbortController();
    await portableBackupService.progress(handle, controller.signal);
    expect(api.get).toHaveBeenCalledWith(`/admin/backup/picpeak/restore/${handle.attemptId}`, {
      headers: { 'X-Picpeak-Restore-Progress': handle.progressToken }, signal: controller.signal,
    });
  });
  it.each([null, '{', 'x'.repeat(257), JSON.stringify({ ...handle, attemptId: '-'.repeat(36) }),
    JSON.stringify({ ...handle, progressToken: 'invalid' })])('does not adopt invalid session progress metadata (%s)', value => {
    if (value !== null) sessionStorage.setItem('picpeak_restore_progress', value);
    expect(readRestoreHandle()).toBeNull();
  });
  it('rejects invalid admission instead of retaining a usable progress handle', async () => {
    vi.mocked(api.post).mockResolvedValue({ data: { ...handle, attemptId: '-'.repeat(36) } });
    await expect(portableBackupService.start(new File(['complete'], 'backup.picpeak'))).rejects.toThrow('Invalid restore admission');
    expect(readRestoreHandle()).toBeNull();
    sessionStorage.setItem('picpeak_restore_progress', JSON.stringify(handle));
    clearRestoreHandle(); expect(readRestoreHandle()).toBeNull();
  });
});
