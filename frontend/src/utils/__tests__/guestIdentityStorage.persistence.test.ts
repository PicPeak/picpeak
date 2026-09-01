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
  clearGuestIdentity,
  getGuestIdentity,
  getGuestToken,
  storeGuestIdentity,
} from '../guestIdentityStorage';

const SLUG = 'wedding-summer-2026';
const IDENTITY = { id: 42, name: 'Tina', email: 'tina@example.com', identifier: 'abc-123' };
const TOKEN = 'header.payload.signature';

/** A tab close clears sessionStorage and leaves localStorage alone. */
function closeTab(): void {
  window.sessionStorage.clear();
}

describe('guest identity persistence (#1265)', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
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
