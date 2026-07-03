/**
 * Per-version dismissal of the "Update available" chip (#567).
 *
 * Admins who deliberately stay on the current version can dismiss the
 * chip; it reappears only when an even newer version is published. The
 * dismissal lives in localStorage keyed by storage version of this
 * helper, so a future schema change can invalidate old dismissals
 * without touching individual admin's storage manually.
 *
 * Single key holds the last-dismissed version string. If the latest
 * version > dismissed version → show the chip. Otherwise hide.
 *
 * Uses a string-based comparison helper so we don't pull in semver
 * just for one greater-than check — see `isNewerVersion` below for
 * the same algorithm the backend's updateCheckService uses.
 */

const STORAGE_KEY = 'picpeak.updateDismissedVersion.v1';

interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  beta: number | null;
}

const parseVersion = (version: string): ParsedVersion | null => {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)(?:-beta\.(\d+))?$/);
  if (!match) return null;
  return {
    major: parseInt(match[1], 10),
    minor: parseInt(match[2], 10),
    patch: parseInt(match[3], 10),
    beta: match[4] ? parseInt(match[4], 10) : null,
  };
};

/** Returns true when `a` is strictly newer than `b`. Mirrors backend semantics. */
export const isNewerVersion = (a: string, b: string): boolean => {
  const va = parseVersion(a);
  const vb = parseVersion(b);
  if (!va || !vb) return false;
  if (va.major !== vb.major) return va.major > vb.major;
  if (va.minor !== vb.minor) return va.minor > vb.minor;
  if (va.patch !== vb.patch) return va.patch > vb.patch;
  // Same major.minor.patch — stable > beta, higher beta > lower beta
  if (va.beta === null && vb.beta !== null) return true;
  if (va.beta !== null && vb.beta === null) return false;
  if (va.beta !== null && vb.beta !== null) return va.beta > vb.beta;
  return false;
};

export const getDismissedVersion = (): string | null => {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
};

export const setDismissedVersion = (version: string): void => {
  try {
    localStorage.setItem(STORAGE_KEY, version);
  } catch {
    // localStorage unavailable (private mode, quota exceeded) — silently
    // skip. The chip will keep reappearing, which is harmless.
  }
};

/**
 * Should the chip be shown for this latest version? True when the user
 * has never dismissed (or dismissed an older version than latest).
 */
export const shouldShowUpdateChip = (latestVersion: string): boolean => {
  const dismissed = getDismissedVersion();
  if (!dismissed) return true;
  return isNewerVersion(latestVersion, dismissed);
};
