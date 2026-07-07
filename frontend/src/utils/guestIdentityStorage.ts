/**
 * Per-gallery guest identity persistence.
 *
 * Stores the guest JWT and profile in sessionStorage, keyed by gallery slug,
 * so multiple open tabs of the same gallery share identity but different
 * browser contexts (and different galleries in the same context) stay
 * independent.
 */

import type { GuestIdentity } from '../services/guests.service';

const TOKEN_KEY_PREFIX = 'guest_token_';
const IDENTITY_KEY_PREFIX = 'guest_identity_';

const isBrowser = typeof window !== 'undefined';

const getStorage = (): Storage | null => {
  if (!isBrowser) return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
};

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
  return storage.getItem(`${TOKEN_KEY_PREFIX}${resolvedSlug}`);
}

export function getGuestIdentity(slug?: string | null): GuestIdentity | null {
  const storage = getStorage();
  if (!storage) return null;
  const resolvedSlug = slug || extractSlugFromLocation();
  if (!resolvedSlug) return null;
  const raw = storage.getItem(`${IDENTITY_KEY_PREFIX}${resolvedSlug}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as GuestIdentity;
  } catch {
    return null;
  }
}

export function clearGuestIdentity(slug: string): void {
  const storage = getStorage();
  if (!storage || !slug) return;
  storage.removeItem(`${TOKEN_KEY_PREFIX}${slug}`);
  storage.removeItem(`${IDENTITY_KEY_PREFIX}${slug}`);
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
