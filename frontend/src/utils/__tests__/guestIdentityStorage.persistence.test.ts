/**
 * Guest identity has to survive a tab close (#1265).
 *
 * It used to live in sessionStorage, so a guest who closed the tab and came
 * back through the same emailed link lost their identity. The `?invite=` token
 * in that link is single-use and already redeemed, so re-registering was the
 * only way back in — and that inserted a second gallery_guests row, orphaning
 * the likes they had already made.
 *
 * The first test here is the one that matters: it fails on the old
 * implementation, because closing a tab clears sessionStorage.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  __resetStorageResolutionForTests,
  clearGuestIdentity,
  getGuestIdentity,
  getGuestToken,
  storeGuestIdentity,
} from '../guestIdentityStorage';

const SLUG = 'wedding-summer-2026';
const IDENTITY = { id: 42, name: 'Tina', email: 'tina@example.com', identifier: 'abc-123' };

/** A JWT-shaped token whose `exp` is `secondsFromNow` away. Signature is irrelevant. */
function tokenExpiringIn(secondsFromNow: number): string {
  const claims = { exp: Math.floor(Date.now() / 1000) + secondsFromNow };
  const payload = btoa(JSON.stringify(claims)).replace(/\+/g, '-').replace(/\//g, '_');
  return `header.${payload}.signature`;
}

const TOKEN = tokenExpiringIn(30 * 24 * 60 * 60);

/** A tab close clears sessionStorage and leaves localStorage alone. */
function closeTab(): void {
  window.sessionStorage.clear();
}

describe('guest identity persistence (#1265)', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    __resetStorageResolutionForTests();
  });

  it('survives a tab close, so a returning guest is still recognised', () => {
    storeGuestIdentity(SLUG, IDENTITY as never, TOKEN);

    closeTab();

    expect(getGuestToken(SLUG)).toBe(TOKEN);
    expect(getGuestIdentity(SLUG)).toMatchObject({ id: 42, email: 'tina@example.com' });
  });

  it('does not write the token to sessionStorage, where a tab close would drop it', () => {
    storeGuestIdentity(SLUG, IDENTITY as never, TOKEN);

    expect(window.sessionStorage.getItem(`guest_token_${SLUG}`)).toBeNull();
    expect(window.localStorage.getItem(`guest_token_${SLUG}`)).toBe(TOKEN);
  });

  it('keeps identities of different galleries independent', () => {
    storeGuestIdentity(SLUG, IDENTITY as never, TOKEN);
    storeGuestIdentity('other-gallery', { ...IDENTITY, id: 7, name: 'Sam' } as never, 'other.token');

    expect(getGuestToken(SLUG)).toBe(TOKEN);
    expect(getGuestToken('other-gallery')).toBe('other.token');
    expect(getGuestIdentity('other-gallery')).toMatchObject({ id: 7 });
  });

  describe('migration from the pre-#1265 sessionStorage location', () => {
    it('adopts an identity left in sessionStorage by the previous build', () => {
      // Exactly what the old implementation would have written.
      window.sessionStorage.setItem(`guest_token_${SLUG}`, TOKEN);
      window.sessionStorage.setItem(`guest_identity_${SLUG}`, JSON.stringify(IDENTITY));

      expect(getGuestToken(SLUG)).toBe(TOKEN);

      // Moved, not copied — otherwise a later "forget me" could be undone by
      // the stale copy being migrated back.
      expect(window.sessionStorage.getItem(`guest_token_${SLUG}`)).toBeNull();
      expect(window.localStorage.getItem(`guest_token_${SLUG}`)).toBe(TOKEN);
    });

    it('lets a fresh registration win over a stale sessionStorage copy', () => {
      window.sessionStorage.setItem(`guest_token_${SLUG}`, 'stale.token');
      storeGuestIdentity(SLUG, IDENTITY as never, TOKEN);

      expect(getGuestToken(SLUG)).toBe(TOKEN);
    });
  });

  describe('an expired token must not look like a signed-in guest', () => {
    // Persisting the token makes "stored but expired" reachable for the first
    // time — sessionStorage almost never survived the 30-day TTL. Nothing else
    // clears it: the 401 handler in config/api.ts only drops
    // `gallery_event_<slug>`, so without this the visitor is shown as signed
    // in while every like silently 401s.
    it('drops an identity whose token has expired', () => {
      storeGuestIdentity(SLUG, IDENTITY as never, tokenExpiringIn(-60));

      expect(getGuestToken(SLUG)).toBeNull();
      expect(getGuestIdentity(SLUG)).toBeNull();
      // Purged, not just hidden, so the next read does no work.
      expect(window.localStorage.getItem(`guest_token_${SLUG}`)).toBeNull();
    });

    it('keeps a token that is still valid', () => {
      storeGuestIdentity(SLUG, IDENTITY as never, tokenExpiringIn(3600));

      expect(getGuestToken(SLUG)).not.toBeNull();
      expect(getGuestIdentity(SLUG)).toMatchObject({ id: 42 });
    });

    it('leaves an unparseable token alone, so the server stays the authority', () => {
      storeGuestIdentity(SLUG, IDENTITY as never, 'not-a-jwt');

      expect(getGuestToken(SLUG)).toBe('not-a-jwt');
    });
  });

  it('does not reject registration when the store refuses writes', () => {
    // localStorage that reads fine but throws on write (quota exhausted).
    // Throwing here would surface as a failed registration *after* the server
    // created the guest — the visitor retries and gets a duplicate row.
    const real = window.localStorage;
    const throwing = {
      getItem: real.getItem.bind(real),
      removeItem: real.removeItem.bind(real),
      key: real.key.bind(real),
      get length() { return real.length; },
      clear: real.clear.bind(real),
      setItem: () => { throw new DOMException('QuotaExceededError'); },
    } as unknown as Storage;
    Object.defineProperty(window, 'localStorage', { value: throwing, configurable: true });
    __resetStorageResolutionForTests();

    expect(() => storeGuestIdentity(SLUG, IDENTITY as never, TOKEN)).not.toThrow();
    // Fell back to sessionStorage rather than losing the identity entirely.
    expect(window.sessionStorage.getItem(`guest_token_${SLUG}`)).toBe(TOKEN);

    Object.defineProperty(window, 'localStorage', { value: real, configurable: true });
    __resetStorageResolutionForTests();
  });

  it('clears both stores, so a cleared identity cannot be migrated back', () => {
    // A guest who registered before the upgrade and again after it has a copy
    // in each store; "forget me" has to remove both.
    window.sessionStorage.setItem(`guest_token_${SLUG}`, 'legacy.token');
    window.sessionStorage.setItem(`guest_identity_${SLUG}`, JSON.stringify(IDENTITY));
    storeGuestIdentity(SLUG, IDENTITY as never, TOKEN);

    clearGuestIdentity(SLUG);

    expect(getGuestToken(SLUG)).toBeNull();
    expect(getGuestIdentity(SLUG)).toBeNull();
    expect(window.sessionStorage.getItem(`guest_token_${SLUG}`)).toBeNull();
    expect(window.localStorage.getItem(`guest_token_${SLUG}`)).toBeNull();
  });
});
