/**
 * Web Storage access that never throws.
 *
 * Private windows, blocked site data and Safari with storage disabled throw a
 * SecurityError on the `localStorage` / `sessionStorage` getter, and a full or
 * zero-quota store throws on `setItem`. The public gallery must still render
 * in those browsers, so a failed read is treated as "nothing stored" and a
 * failed write is dropped; callers keep the value in memory for the page view.
 */
type StorageKind = 'local' | 'session';

const resolve = (kind: StorageKind): Storage =>
  kind === 'local' ? window.localStorage : window.sessionStorage;

export function safeGetItem(kind: StorageKind, key: string): string | null {
  try {
    return resolve(kind).getItem(key);
  } catch {
    return null;
  }
}

export function safeSetItem(kind: StorageKind, key: string, value: string): void {
  try {
    resolve(kind).setItem(key, value);
  } catch {
    // Storage unavailable: the caller's in-memory state covers this page view.
  }
}

export function safeRemoveItem(kind: StorageKind, key: string): void {
  try {
    resolve(kind).removeItem(key);
  } catch {
    // Storage unavailable: nothing could have been stored either.
  }
}
