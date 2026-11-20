/**
 * A full or database restore replaces admin_users and invalidates every
 * session issued before it (backend sessionCutoff.js), so the restore wizard's
 * next status poll gets a 401 and the page reloads into the login screen,
 * wiping the wizard's state. The wizard leaves this marker in sessionStorage
 * (same tab, survives the reload) when it starts a restore; after sign-in the
 * login page sends the admin back to the restore tab, and the wizard shows the
 * outcome of that run before clearing the marker.
 */

const KEY = 'picpeak_restore_run';

/** Where the login page sends the admin while a marker is present. */
export const RESTORE_RESULT_PATH = '/admin/settings?tab=backup&backupTab=restore';

export interface RestoreRunMarker {
  /** Server time just before the run started; its restore_runs row starts at or after it. */
  startedAfter: string;
  /** Set when an admin request got a 401 while the marker was present. */
  signedOut?: boolean;
}

export function readRestoreRun(): RestoreRunMarker | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    const marker = JSON.parse(raw);
    return marker && typeof marker.startedAfter === 'string' ? marker : null;
  } catch {
    return null;
  }
}

export function rememberRestoreRun(marker: RestoreRunMarker): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(marker));
  } catch {
    // Storage unavailable: the wizard still shows the result in this page.
  }
}

export function clearRestoreRun(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // ignore
  }
}

/** Called by the API client on an admin 401: the restore signed this session out. */
export function noteRestoreSignOut(): void {
  const marker = readRestoreRun();
  if (marker && !marker.signedOut) rememberRestoreRun({ ...marker, signedOut: true });
}

const toMs = (value: unknown): number => {
  if (value == null || value === '') return NaN;
  return new Date(value as string | number).getTime();
};

/** True when this restore_runs row is the run the marker was set for. */
export function isRunOf(row: { started_at?: unknown } | null | undefined, marker: RestoreRunMarker): boolean {
  const started = toMs(row?.started_at);
  const after = toMs(marker.startedAfter);
  return Number.isFinite(started) && Number.isFinite(after) && started >= after;
}
