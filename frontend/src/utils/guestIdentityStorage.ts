/**
 * Per-gallery guest identity persistence.
 *
 * Stores the guest JWT and profile in localStorage, keyed by gallery slug, so
 * a guest who closes the tab and comes back through the same emailed link is
 * still recognised as themselves.
 *
 * This used to be sessionStorage, which meant the practical lifetime of the
 * identity was "until this tab closes" — the GUEST_TOKEN_TTL of 30 days
 * (raised in #1216 precisely to stop identity churn) was almost never reached.
 * A returning guest got the registration prompt again, and because the
 * `?invite=` token in their link is single-use and already redeemed, they had
 * no way back to their own identity. Typing the same name again inserted a
 * second gallery_guests row, so their earlier likes belonged to an identity
 * they could no longer act as (#1265).
 *
 * Why this does not reopen the objection #1216 raised: deduplicating on a
 * typed email was rejected because anyone who knows an address could claim
 * that person's identity. This grants nothing to anyone — it only stops the
 * browser discarding a token it was already given. Note also that gallery
 * ACCESS lives in sessionStorage (galleryAuthStorage.ts) and is unaffected, so
 * a returning visitor still has to pass the gallery password before a stored
 * identity means anything.
 */

import type { GuestIdentity } from '../services/guests.service';

const TOKEN_KEY_PREFIX = 'guest_token_';
const IDENTITY_KEY_PREFIX = 'guest_identity_';

const isBrowser = typeof window !== 'undefined';

const getStorage = (): Storage | null => {
  if (!isBrowser) return null;
  try {
    return window.localStorage;
  } catch {
    // Safari in private mode, or storage blocked by policy. Fall back to
    // sessionStorage rather than dropping identity entirely — that is the old
    // behaviour, which is degraded but still works within a single tab.
    try {
      return window.sessionStorage;
    } catch {
      return null;
    }
  }
};

/**
 * Move a pre-#1265 identity out of sessionStorage on first read.
 *
 * Without this, everyone with a gallery open at upgrade time is treated as a
 * new guest the moment they reload — which is the exact duplicate-row bug this
 * change exists to stop, fired once per in-flight guest.
 */
function migrateFromSessionStorage(slug: string): void {
  if (!isBrowser) return;
  const target = getStorage();
  if (!target || target === window.sessionStorage) return;
  let legacy: Storage;
  try {
    legacy = window.sessionStorage;
  } catch {
    return;
  }
  const tokenKey = `${TOKEN_KEY_PREFIX}${slug}`;
  const identityKey = `${IDENTITY_KEY_PREFIX}${slug}`;
  try {
    const legacyToken = legacy.getItem(tokenKey);
    // Only migrate when the new store has nothing — a fresh registration in
    // this tab must always win over a stale copy left in sessionStorage.
    if (legacyToken && !target.getItem(tokenKey)) {
      target.setItem(tokenKey, legacyToken);
      const legacyIdentity = legacy.getItem(identityKey);
      if (legacyIdentity) target.setItem(identityKey, legacyIdentity);
    }
    legacy.removeItem(tokenKey);
    legacy.removeItem(identityKey);
  } catch {
    // Best-effort: a failed migration just means the guest re-registers.
  }
}

export function storeGuestIdentity(slug: string, identity: GuestIdentity, token: string): void {
  const storage = getStorage();
  if (!storage || !slug) return;
  storage.setItem(`${TOKEN_KEY_PREFIX}${slug}`, token);
  storage.setItem(`${IDENTITY_KEY_PREFIX}${slug}`, JSON.stringify(identity));
}

export function getGuestToken(slug?: string | null): string | null {
  const storage = getStorage();
  if (!storage) return null;
  const resolvedSlug = slug || extractSlugFromLocation();
  if (!resolvedSlug) return null;
  migrateFromSessionStorage(resolvedSlug);
  return storage.getItem(`${TOKEN_KEY_PREFIX}${resolvedSlug}`);
}

export function getGuestIdentity(slug?: string | null): GuestIdentity | null {
  const storage = getStorage();
  if (!storage) return null;
  const resolvedSlug = slug || extractSlugFromLocation();
  if (!resolvedSlug) return null;
  migrateFromSessionStorage(resolvedSlug);
  const raw = storage.getItem(`${IDENTITY_KEY_PREFIX}${resolvedSlug}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as GuestIdentity;
  } catch {
    return null;
  }
}

export function clearGuestIdentity(slug: string): void {
  if (!slug) return;
  // Clear BOTH stores: a copy left behind in sessionStorage would be migrated
  // straight back on the next read, silently undoing "forget me".
  const stores: Storage[] = [];
  const primary = getStorage();
  if (primary) stores.push(primary);
  if (isBrowser) {
    try {
      if (window.sessionStorage && !stores.includes(window.sessionStorage)) {
        stores.push(window.sessionStorage);
      }
    } catch {
      // sessionStorage unavailable — nothing to clear there.
    }
  }
  for (const storage of stores) {
    try {
      storage.removeItem(`${TOKEN_KEY_PREFIX}${slug}`);
      storage.removeItem(`${IDENTITY_KEY_PREFIX}${slug}`);
    } catch {
      // Best-effort.
    }
  }
}

/**
 * Extract the gallery slug from a request URL path like "/gallery/:slug/...".
 * Matches the axios interceptor logic in api.ts.
 */
export function extractGuestSlugFromUrl(url: string): string | null {
  if (!url) return null;
  const pathOnly = url.startsWith('http://') || url.startsWith('https://')
    ? (() => {
        try {
          return new URL(url).pathname;
        } catch {
          return url;
        }
      })()
    : url;
  const match = pathOnly.match(/\/gallery\/([^/?#]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

function extractSlugFromLocation(): string | null {
  if (!isBrowser) return null;
  const match = window.location.pathname.match(/\/gallery\/([^/?#]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}
