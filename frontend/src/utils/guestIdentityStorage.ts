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

/**
 * A store is only usable if it can be WRITTEN, not merely read.
 *
 * Guarding the property access alone is not enough: there are browsers and
 * states (quota exhausted, Safari private mode historically) where
 * `window.localStorage` resolves fine but `setItem` throws. That would sail
 * past a read-only guard, and then storeGuestIdentity() would throw *after*
 * the server had already created the guest — the registration would report
 * failure, the visitor would try again, and the retry would insert the second
 * gallery_guests row this whole change exists to prevent.
 */
function isUsable(storage: Storage): boolean {
  const probe = '__picpeak_probe__';
  try {
    storage.setItem(probe, '1');
    storage.removeItem(probe);
    return true;
  } catch {
    return false;
  }
}

// Resolved once. getGuestToken() runs on every API request through the axios
// interceptor, and probing a write each time would be wasteful.
let resolvedStorage: Storage | null | undefined;

const getStorage = (): Storage | null => {
  if (!isBrowser) return null;
  if (resolvedStorage !== undefined) return resolvedStorage;

  for (const pick of [() => window.localStorage, () => window.sessionStorage]) {
    let candidate: Storage;
    try {
      candidate = pick();
    } catch {
      continue;
    }
    if (candidate && isUsable(candidate)) {
      resolvedStorage = candidate;
      return resolvedStorage;
    }
  }
  // sessionStorage is the degraded fallback: identity lasts one tab, which is
  // the pre-#1265 behaviour rather than no identity at all.
  resolvedStorage = null;
  return resolvedStorage;
};

/** Test seam — storage availability is resolved once per page load. */
export function __resetStorageResolutionForTests(): void {
  resolvedStorage = undefined;
}

/**
 * Treat a token past its `exp` as absent.
 *
 * GUEST_TOKEN_TTL is 30 days, and until now sessionStorage almost never
 * survived long enough to reach it. Persisting the token makes "stored but
 * expired" a reachable state, and nothing clears it: the 401 handler in
 * config/api.ts only drops `gallery_event_<slug>`. Without this the visitor is
 * shown as signed in while every like silently 401s, and ensureIdentity()
 * short-circuits so they are never offered recovery.
 *
 * The signature is not verified here — that is the server's job. This only
 * reads the expiry so the client stops presenting an identity the backend has
 * already stopped honouring. A token we cannot parse is left alone rather than
 * discarded, so the server stays the authority on anything ambiguous.
 */
function isExpired(token: string): boolean {
  const payload = token.split('.')[1];
  if (!payload) return false;
  try {
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const claims = JSON.parse(atob(base64)) as { exp?: number };
    if (typeof claims.exp !== 'number') return false;
    return claims.exp * 1000 <= Date.now();
  } catch {
    return false;
  }
}

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
  const write = (target: Storage): boolean => {
    try {
      target.setItem(`${TOKEN_KEY_PREFIX}${slug}`, token);
      target.setItem(`${IDENTITY_KEY_PREFIX}${slug}`, JSON.stringify(identity));
      return true;
    } catch {
      return false;
    }
  };

  if (write(storage)) return;

  // The probe in getStorage() only proves a one-byte write fits; a JWT plus a
  // profile is far larger, so a nearly-full store can pass the probe and still
  // reject the real write. Retry in sessionStorage rather than leaving the
  // context believing it is signed in with nothing persisted — that state
  // 401s immediately and re-registers (another duplicate row) on reload.
  if (isBrowser) {
    try {
      if (window.sessionStorage && window.sessionStorage !== storage) {
        write(window.sessionStorage);
      }
    } catch {
      // No store will take it. The identity lasts as long as this page does,
      // which is strictly better than rejecting a registration the server has
      // already completed.
    }
  }
}

export function getGuestToken(slug?: string | null): string | null {
  const storage = getStorage();
  if (!storage) return null;
  const resolvedSlug = slug || extractSlugFromLocation();
  if (!resolvedSlug) return null;
  migrateFromSessionStorage(resolvedSlug);
  const token = storage.getItem(`${TOKEN_KEY_PREFIX}${resolvedSlug}`);
  if (token && isExpired(token)) {
    clearGuestIdentity(resolvedSlug);
    return null;
  }
  return token;
}

export function getGuestIdentity(slug?: string | null): GuestIdentity | null {
  const storage = getStorage();
  if (!storage) return null;
  const resolvedSlug = slug || extractSlugFromLocation();
  if (!resolvedSlug) return null;
  migrateFromSessionStorage(resolvedSlug);
  // An identity whose token has expired must not be presented as signed in —
  // clearGuestIdentity() has already run inside getGuestToken() in that case.
  if (!getGuestToken(resolvedSlug)) return null;
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
