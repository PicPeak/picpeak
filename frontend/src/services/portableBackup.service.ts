import { api } from '../config/api';

export interface RestoreHandle { attemptId: string; progressToken: string }
export interface RestoreFailure { code: string; message: string; statusCode?: number }
export interface RestoreProgress {
  attemptId: string;
  state: 'open' | 'draining' | 'restoring' | 'recovery_required' | 'restart_required';
  outcome: 'committed' | 'rolled_back' | 'aborted' | 'recovery_required' | null;
  restartRequired: boolean;
  complete: boolean;
  // Why a restore did not go through; null while it runs and after a commit.
  error?: RestoreFailure | null;
  summary: { tables?: number; filesRestored?: number; usesExternalMedia?: boolean; crossEngine?: boolean };
}
// Whether this host can run a portable restore at all (Linux, native build,
// local storage); `reason` is a stable code, `message` its English fallback.
export interface RestoreCapability {
  available: boolean;
  reason: string | null;
  message: string | null;
  maintenance: boolean;
  restartRequired: boolean;
}
const STORAGE_KEY = 'picpeak_restore_progress';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const RESTORE_HANDLE_EVENT = 'picpeak-restore-handle';

export function readRestoreHandle(): RestoreHandle | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw || raw.length > 256) return null;
    const value = JSON.parse(raw);
    return typeof value.attemptId === 'string' && UUID.test(value.attemptId)
      && typeof value.progressToken === 'string' && /^[0-9a-f]{64}$/.test(value.progressToken) ? value : null;
  } catch { return null; }
}
export function clearRestoreHandle() {
  sessionStorage.removeItem(STORAGE_KEY);
  window.dispatchEvent(new Event(RESTORE_HANDLE_EVENT));
}
export const portableBackupService = {
  async capability(): Promise<RestoreCapability> {
    return (await api.get<RestoreCapability>('/admin/backup/picpeak/restore-capability')).data;
  },
  export(includePhotos: boolean) {
    return api.get('/admin/backup/picpeak/export', { params: { includePhotos }, responseType: 'blob' });
  },
  async start(file: File): Promise<RestoreHandle> {
    const data = new FormData();
    data.append('backup', file);
    const response = await api.post<RestoreHandle>('/admin/backup/picpeak/import', data);
    const handle = response.data;
    if (!UUID.test(handle.attemptId) || !/^[0-9a-f]{64}$/.test(handle.progressToken)) throw new Error('Invalid restore admission');
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ attemptId: handle.attemptId, progressToken: handle.progressToken }));
    window.dispatchEvent(new Event(RESTORE_HANDLE_EVENT));
    return handle;
  },
  async progress(handle: RestoreHandle, signal?: AbortSignal): Promise<RestoreProgress> {
    const response = await api.get<RestoreProgress>(`/admin/backup/picpeak/restore/${encodeURIComponent(handle.attemptId)}`, {
      headers: { 'X-Picpeak-Restore-Progress': handle.progressToken }, signal,
    });
    return response.data;
  },
};
