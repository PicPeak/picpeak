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

/** Same-tab counterpart to the native cross-tab `storage` event. */
export const GUEST_IDENTITY_CLEARED_EVENT = 'picpeak:guest-identity-cleared';

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
  promotionFailed.clear();
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
 * The secondary store: sessionStorage, whenever it is distinct from the store
 * reads are resolved against. Two things can live there — a pre-#1265
 * identity the previous build wrote, and the quota fallback below.
 */
function secondaryStore(primary: Storage): Storage | null {
  if (!isBrowser) return null;
  try {
    const candidate = window.sessionStorage;
    return candidate && candidate !== primary ? candidate : null;
  } catch {
    return null;
  }
}

/**
 * Write the pair to one store, PROFILE FIRST. A store that is nearly full can
 * accept the first write and reject the second, and "token stored, profile
 * missing" is the one partial state that produces the duplicate-row bug this
 * file exists to stop: the interceptor sends x-guest-token while the provider
 * sees no identity, prompts, and registers a second guest. A profile without
 * a token is inert. Anything half-written is removed again before reporting
 * failure, so a store either holds the whole pair or none of it.
 */
function writePair(target: Storage, slug: string, identityRaw: string, token: string): boolean {
  const tokenKey = `${TOKEN_KEY_PREFIX}${slug}`;
  const identityKey = `${IDENTITY_KEY_PREFIX}${slug}`;
  try {
    target.setItem(identityKey, identityRaw);
    target.setItem(tokenKey, token);
    return true;
  } catch {
    try {
      target.removeItem(tokenKey);
      target.removeItem(identityKey);
    } catch {
      // Nothing more to do.
    }
    return false;
  }
}

// Slugs whose pair could not be promoted into the primary store on this page
// load. getGuestToken() runs on every API request; once the primary store has
// refused the write there is no point retrying it per request.
const promotionFailed = new Set<string>();

/**
 * Read the pair, looking in the primary store first and the secondary one
 * second. Finding it in the secondary store covers two cases that used to be
 * one-way migrations and are now read-through:
 *
 *   - a pre-#1265 identity the previous build left in sessionStorage. Without
 *     this everyone with a gallery open at upgrade time is treated as a new
 *     guest on reload — the exact duplicate-row bug, fired once per guest;
 *   - the quota fallback in storeGuestIdentity(). That used to repoint reads
 *     at sessionStorage through module state, which a reload discards: the
 *     next page load probed localStorage, passed, and read nothing while the
 *     identity sat unreadable one store over. Reads now find it wherever it
 *     demonstrably fits.
 *
 * A pair found in the secondary store is promoted into the primary one when
 * that store will take it (MOVED, not copied — a stale copy would otherwise
 * be migrated straight back after "forget me"), and left where it is when it
 * will not. A pair already in the primary store always wins over the
 * secondary copy: a fresh registration in this tab beats a stale leftover.
 */
function readPair(slug: string): { token: string | null; identityRaw: string | null } {
  const primary = getStorage();
  if (!primary) return { token: null, identityRaw: null };
  const tokenKey = `${TOKEN_KEY_PREFIX}${slug}`;
  const identityKey = `${IDENTITY_KEY_PREFIX}${slug}`;

  let token: string | null = null;
  let identityRaw: string | null = null;
  try {
    token = primary.getItem(tokenKey);
    identityRaw = primary.getItem(identityKey);
  } catch {
    return { token: null, identityRaw: null };
  }

  const secondary = secondaryStore(primary);
  if (!secondary) return { token, identityRaw };

  let secondaryToken: string | null = null;
  let secondaryIdentity: string | null = null;
  try {
    secondaryToken = secondary.getItem(tokenKey);
    secondaryIdentity = secondary.getItem(identityKey);
  } catch {
    return { token, identityRaw };
  }

  if (token) {
    // Primary wins. Drop the leftover so it can never be promoted later.
    if (secondaryToken || secondaryIdentity) {
      try {
        secondary.removeItem(tokenKey);
        secondary.removeItem(identityKey);
      } catch {
        // Best-effort.
      }
    }
    return { token, identityRaw };
  }

  if (!secondaryToken) return { token: null, identityRaw };

  if (!promotionFailed.has(slug) && secondaryIdentity && writePair(primary, slug, secondaryIdentity, secondaryToken)) {
    try {
      secondary.removeItem(tokenKey);
      secondary.removeItem(identityKey);
    } catch {
      // The copy stays behind; the primary now wins on every later read.
    }
  } else if (secondaryIdentity) {
    promotionFailed.add(slug);
  }
  return { token: secondaryToken, identityRaw: secondaryIdentity };
}

export function storeGuestIdentity(slug: string, identity: GuestIdentity, token: string): void {
  const storage = getStorage();
  if (!storage || !slug) return;
  const identityRaw = JSON.stringify(identity);

  if (writePair(storage, slug, identityRaw, token)) {
    // A fresh registration supersedes anything the secondary store holds.
    const secondary = secondaryStore(storage);
    if (secondary) {
      try {
        secondary.removeItem(`${TOKEN_KEY_PREFIX}${slug}`);
        secondary.removeItem(`${IDENTITY_KEY_PREFIX}${slug}`);
      } catch {
        // Best-effort.
      }
    }
    return;
  }

  // The probe in getStorage() only proves a one-byte write fits; a JWT plus a
  // profile is far larger, so a nearly-full store can pass the probe and still
  // reject the real write. Retry in sessionStorage rather than leaving the
  // context believing it is signed in with nothing persisted — that state
  // 401s immediately and re-registers (another duplicate row) on reload.
  // readPair() looks there on every read, including after a reload, so no
  // module state has to remember which store took the write.
  const secondary = secondaryStore(storage);
  if (secondary) {
    promotionFailed.add(slug);
    writePair(secondary, slug, identityRaw, token);
  }
  // Otherwise no store will take it. The identity lasts as long as this page
  // does, which is strictly better than rejecting a registration the server
  // has already completed.
}

export function getGuestToken(slug?: string | null): string | null {
  const resolvedSlug = slug || extractSlugFromLocation();
  if (!resolvedSlug) return null;
  const { token } = readPair(resolvedSlug);
  if (token && isExpired(token)) {
    clearGuestIdentity(resolvedSlug);
    return null;
  }
  return token;
}

export function getGuestIdentity(slug?: string | null): GuestIdentity | null {
  const resolvedSlug = slug || extractSlugFromLocation();
  if (!resolvedSlug) return null;
  const { token, identityRaw } = readPair(resolvedSlug);
  // An identity whose token has expired must not be presented as signed in.
  if (!token) return null;
  if (isExpired(token)) {
    clearGuestIdentity(resolvedSlug);
    return null;
  }
  if (!identityRaw) return null;
  try {
    return JSON.parse(identityRaw) as GuestIdentity;
  } catch {
    return null;
  }
}

export function clearGuestIdentity(slug: string): void {
  if (!slug) return;
  promotionFailed.delete(slug);
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

  // `storage` events fire only in OTHER documents, so a clear triggered inside
  // this tab (the axios interceptor dropping a server-rejected identity) would
  // leave the provider still showing the guest and ensureIdentity() still
  // handing it out. Announce it locally too.
  if (isBrowser) {
    try {
      window.dispatchEvent(new CustomEvent(GUEST_IDENTITY_CLEARED_EVENT, { detail: { slug } }));
    } catch {
      // CustomEvent unavailable — the provider simply refreshes on next mount.
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
