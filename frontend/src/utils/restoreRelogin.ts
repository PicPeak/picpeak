/**
 * A full or database restore replaces admin_users and invalidates every
 * session issued before it (backend sessionCutoff.js), so the restore wizard's
 * next status poll gets a 401 and the page reloads into the login screen,
 * wiping the wizard's state. The wizard leaves this marker in sessionStorage
 * (same tab, survives the reload) when it starts a restore; after sign-in the
 * login page sends the admin back to the restore tab, and the wizard shows the
 * outcome of that run before clearing the marker.
 *
 * The marker must not outlive its use: it expires RESTORE_RUN_TTL_MS after
 * the start, and the login page follows it once. The wizard re-arms the
 * redirect when it opens on the run, so only an admin who can see the
 * restore tab is sent back there after a later sign-out.
 */

const KEY = 'picpeak_restore_run';

export const RESTORE_RUN_TTL_MS = 2 * 60 * 60 * 1000;
/** How long the wizard waits for a run that is neither running nor recorded. */
export const RESTORE_RUN_GRACE_MS = 30 * 1000;

/** Where the login page sends the admin while a marker is present. */
export const RESTORE_RESULT_PATH = '/admin/settings?tab=backup&backupTab=restore';

export interface RestoreRunMarker {
  /** Server time just before the run started; its restore_runs row starts at or after it. */
  startedAfter: string;
  /** Browser clock (ms) at the start; TTL and grace periods use it, not server time. */
  since: number;
  /** Set when an admin request got a 401 while the marker was present. */
  signedOut?: boolean;
  /** Set when the login page has followed the marker; the wizard clears it again. */
  redirected?: boolean;
}

export function readRestoreRun(): RestoreRunMarker | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    const marker = JSON.parse(raw);
    if (!marker || typeof marker.startedAfter !== 'string' || !Number.isFinite(marker.since)) {
      sessionStorage.removeItem(KEY);
      return null;
    }
    if (Date.now() - marker.since > RESTORE_RUN_TTL_MS) {
      sessionStorage.removeItem(KEY);
      return null;
    }
    return marker;
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

/**
 * Login page: true (once) when a tracked restore should be shown after this
 * sign-in. Later sign-ins go to the dashboard unless the wizard re-armed it.
 * The dashboard asks with `afterSignOut`: an SSO sign-in lands there directly
 * (the callback redirects to /admin/dashboard), and an admin who opens the
 * dashboard while the restore runs, without being signed out, stays there.
 */
export function takeRestoreRedirect({ afterSignOut = false }: { afterSignOut?: boolean } = {}): boolean {
  const marker = readRestoreRun();
  if (!marker || marker.redirected || (afterSignOut && !marker.signedOut)) return false;
  rememberRestoreRun({ ...marker, redirected: true });
  return true;
}

/** Wizard: the admin reached the run, so a later sign-out may bring them back. */
export function rearmRestoreRedirect(): void {
  const marker = readRestoreRun();
  if (marker?.redirected) rememberRestoreRun({ ...marker, redirected: false });
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
