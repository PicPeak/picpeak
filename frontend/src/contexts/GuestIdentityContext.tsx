import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { guestsService, GuestIdentity } from '../services/guests.service';
import {
  GUEST_IDENTITY_CLEARED_EVENT,
  clearGuestIdentity,
  getGuestIdentity,
  storeGuestIdentity,
} from '../utils/guestIdentityStorage';

type IdentityMode = 'simple' | 'guest';

interface GuestIdentityContextValue {
  slug: string;
  identity: GuestIdentity | null;
  identityMode: IdentityMode;
  isRequired: boolean;            // true when mode='guest' AND no identity yet
  promptOpen: boolean;
  recoveryOpen: boolean;
  openPrompt: () => void;
  closePrompt: () => void;
  openRecovery: () => void;
  closeRecovery: () => void;
  register: (name: string, email?: string) => Promise<GuestIdentity>;
  recoverRequest: (email: string) => Promise<void>;
  recoverVerify: (email: string, code: string) => Promise<GuestIdentity>;
  forget: () => Promise<void>;
  /**
   * Drop the stored identity on THIS device without touching the server.
   *
   * Distinct from forget(), which soft-deletes the guest row and anonymizes
   * their feedback. Now that identity survives a tab close (#1265), a second
   * person on a shared computer can be greeted as whoever used it last — and
   * their only previous exit was forget(), which would erase that person's
   * name and selections. This is the non-destructive way out.
   */
  signOut: () => void;
  /**
   * Used by feedback components. Returns the current identity, or opens the
   * prompt and waits until the user registers (or cancels, in which case it
   * throws a "user_cancelled" error).
   */
  ensureIdentity: () => Promise<GuestIdentity>;
}

const GuestIdentityContext = createContext<GuestIdentityContextValue | null>(null);

interface GuestIdentityProviderProps {
  slug: string;
  identityMode: IdentityMode;
  children: React.ReactNode;
}

export const GuestIdentityProvider: React.FC<GuestIdentityProviderProps> = ({
  slug,
  identityMode,
  children,
}) => {
  const queryClient = useQueryClient();
  const [identity, setIdentity] = useState<GuestIdentity | null>(() => getGuestIdentity(slug));
  const [promptOpen, setPromptOpen] = useState(false);
  const [recoveryOpen, setRecoveryOpen] = useState(false);

  // Pending promise resolvers for ensureIdentity() calls waiting on prompt.
  const pendingResolvers = useRef<Array<(identity: GuestIdentity) => void>>([]);
  const pendingRejecters = useRef<Array<(reason: Error) => void>>([]);

  // Rehydrate identity when slug changes.
  useEffect(() => {
    setIdentity(getGuestIdentity(slug));
  }, [slug]);

  // Keep tabs in step. The identity now lives in localStorage, which is shared
  // across tabs — where sessionStorage gave each tab its own copy. So "Not
  // you?" or a fresh registration in one tab silently changes the token the
  // axios interceptor sends from every other tab, while those tabs still show
  // the old name. Their likes would then be recorded against the new guest:
  // the same misattribution this change set out to stop.
  //
  // `storage` fires only in the OTHER tabs, which is exactly the audience that
  // needs to catch up. A null key means the whole store was cleared.
  useEffect(() => {
    if (typeof window === 'undefined') return;

    const adopt = () => {
      const next = getGuestIdentity(slug);
      setIdentity(next);
      if (next) {
        // A caller may be parked on the prompt waiting for ensureIdentity().
        // Another tab just answered the question, so complete them exactly as
        // register() does — otherwise the action hangs forever and submitting
        // the still-open prompt registers a second guest.
        setPromptOpen(false);
        setRecoveryOpen(false);
        pendingResolvers.current.forEach((r) => r(next));
        pendingResolvers.current = [];
        pendingRejecters.current = [];
      }
    };

    const onStorage = (event: StorageEvent) => {
      if (event.key && event.key !== `guest_token_${slug}` && event.key !== `guest_identity_${slug}`) {
        return;
      }
      adopt();
    };
    // Fires in THIS tab, where `storage` does not — e.g. the axios interceptor
    // dropping an identity the server has rejected.
    const onLocalClear = (event: Event) => {
      const detail = (event as CustomEvent<{ slug?: string }>).detail;
      if (detail?.slug && detail.slug !== slug) return;
      adopt();
    };

    window.addEventListener('storage', onStorage);
    window.addEventListener(GUEST_IDENTITY_CLEARED_EVENT, onLocalClear);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener(GUEST_IDENTITY_CLEARED_EVENT, onLocalClear);
    };
  }, [slug]);

  // Guest-scoped caches are keyed by slug and photo id, never by guest id, so
  // they survive an identity change and would keep showing the previous
  // guest's likes, favourites and ratings while requests already carry the new
  // token. Reachable three ways now: another tab signing in or out, "Not
  // you?", and a ?invite= redemption over an existing identity.
  const previousIdentityId = useRef<number | null>(identity?.id ?? null);
  // Invalidating queries is not enough on its own: six gallery layouts seed
  // their liked-photo set behind a `likedSeededRef` that is deliberately
  // mount-only ("so refetches don't clobber in-session optimistic toggles"),
  // and PhotoLightbox holds its own copy. A refetch therefore leaves the
  // previous guest's hearts on screen. Bumping this generation re-keys the
  // subtree so every such consumer is rebuilt.
  const [identityGeneration, setIdentityGeneration] = useState(0);
  useEffect(() => {
    const currentId = identity?.id ?? null;
    const previousId = previousIdentityId.current;
    if (previousId === currentId) return;
    previousIdentityId.current = currentId;

    queryClient.invalidateQueries({ queryKey: ['my-feedback', slug] });
    queryClient.invalidateQueries({ queryKey: ['gallery-photos', slug] });
    // Every mounted photo, regardless of id.
    queryClient.invalidateQueries({ queryKey: ['photo-feedback', slug] });

    // Only on a SWITCH away from an established identity — signing in for the
    // first time (null -> A) must not remount, or registering from the prompt
    // would tear down the gallery under the very click that triggered it and
    // drop the pending action.
    if (previousId !== null) setIdentityGeneration((g) => g + 1);
  }, [identity, slug, queryClient]);

  // When an invite token is present on the URL (?invite=xxx), redeem it once
  // on mount. The server returns a guest token we can persist.
  //
  // Deliberately NOT skipped when an identity already exists. It used to be,
  // which was harmless while identity died with the tab — but now that it
  // persists, opening guest B's invite link on a browser where guest A once
  // visited would restore A, skip the redemption entirely, and file B's likes
  // under A. An explicit invite is the strongest statement of who the visitor
  // is, so it wins over whatever the browser happens to be holding.
  //
  // The ref keeps it to one redemption per token: `identity` is no longer in
  // the dependency list precisely because redeeming sets it.
  const redeemedInviteRef = useRef<string | null>(null);
  // Redemption is async, and the gallery stays interactive while it runs. A
  // like clicked in that window would otherwise resolve against the persisted
  // identity and be filed under the wrong guest, permanently. ensureIdentity()
  // waits on this instead.
  const invitePromiseRef = useRef<Promise<void> | null>(null);
  useEffect(() => {
    if (identityMode !== 'guest') return;
    const params = new URLSearchParams(window.location.search);
    const inviteToken = params.get('invite');
    if (!inviteToken || redeemedInviteRef.current === inviteToken) return;
    redeemedInviteRef.current = inviteToken;

    invitePromiseRef.current = (async () => {
      try {
        const response = await guestsService.redeemInvite(slug, inviteToken);
        storeGuestIdentity(slug, response.guest, response.token);
        setIdentity(response.guest);
        // Strip invite param from URL to prevent re-redemption on reload.
        params.delete('invite');
        const newSearch = params.toString();
        const newUrl = window.location.pathname + (newSearch ? `?${newSearch}` : '') + window.location.hash;
        window.history.replaceState({}, '', newUrl);
      } catch (error) {
        // Silently fail invalid invites; user will fall back to normal prompt.
        // eslint-disable-next-line no-console
        console.warn('Failed to redeem invite token', error);
      } finally {
        invitePromiseRef.current = null;
      }
    })();
  }, [slug, identityMode]);

  const openPrompt = useCallback(() => setPromptOpen(true), []);
  const closePrompt = useCallback(() => {
    setPromptOpen(false);
    // Reject any pending ensureIdentity() promises.
    pendingRejecters.current.forEach((r) => r(new Error('user_cancelled')));
    pendingResolvers.current = [];
    pendingRejecters.current = [];
  }, []);

  const openRecovery = useCallback(() => setRecoveryOpen(true), []);
  const closeRecovery = useCallback(() => setRecoveryOpen(false), []);

  const register = useCallback(
    async (name: string, email?: string): Promise<GuestIdentity> => {
      const response = await guestsService.registerGuest(slug, { name, email });
      storeGuestIdentity(slug, response.guest, response.token);
      setIdentity(response.guest);
      setPromptOpen(false);
      // Resolve pending ensureIdentity() promises.
      pendingResolvers.current.forEach((r) => r(response.guest));
      pendingResolvers.current = [];
      pendingRejecters.current = [];
      return response.guest;
    },
    [slug]
  );

  const recoverRequest = useCallback(
    async (email: string): Promise<void> => {
      await guestsService.requestRecoveryCode(slug, email);
    },
    [slug]
  );

  const recoverVerify = useCallback(
    async (email: string, code: string): Promise<GuestIdentity> => {
      const response = await guestsService.verifyRecoveryCode(slug, email, code);
      storeGuestIdentity(slug, response.guest, response.token);
      setIdentity(response.guest);
      setPromptOpen(false);
      setRecoveryOpen(false);
      pendingResolvers.current.forEach((r) => r(response.guest));
      pendingResolvers.current = [];
      pendingRejecters.current = [];
      return response.guest;
    },
    [slug]
  );

  const forget = useCallback(async (): Promise<void> => {
    try {
      if (identity) {
        await guestsService.forgetMe(slug);
      }
    } catch {
      // Best-effort. Clear local state regardless.
    }
    clearGuestIdentity(slug);
    setIdentity(null);
  }, [slug, identity]);

  const signOut = useCallback((): void => {
    clearGuestIdentity(slug);
    setIdentity(null);
  }, [slug]);

  const ensureIdentity = useCallback(async (): Promise<GuestIdentity> => {
    if (identityMode !== 'guest') {
      // In simple mode, there is no per-person identity. Return a synthetic
      // "null" identity that callers will ignore.
      return Promise.resolve({
        id: 0,
        name: '',
        email: null,
        identifier: '',
      } as GuestIdentity);
    }
    // An invite naming this visitor is mid-flight: wait for it rather than
    // answering with the identity the browser happened to be holding.
    if (invitePromiseRef.current) {
      try {
        await invitePromiseRef.current;
      } catch {
        // Redemption failed — fall through to the stored identity / prompt.
      }
      const redeemed = getGuestIdentity(slug);
      if (redeemed) return redeemed;
    }

    if (identity) return identity;

    return new Promise((resolve, reject) => {
      pendingResolvers.current.push(resolve);
      pendingRejecters.current.push(reject);
      setPromptOpen(true);
    });
  }, [identityMode, identity, slug]);

  const isRequired = identityMode === 'guest' && !identity;

  const value = useMemo<GuestIdentityContextValue>(
    () => ({
      slug,
      identity,
      identityMode,
      isRequired,
      promptOpen,
      recoveryOpen,
      openPrompt,
      closePrompt,
      openRecovery,
      closeRecovery,
      register,
      recoverRequest,
      recoverVerify,
      forget,
      signOut,
      ensureIdentity,
    }),
    [
      slug,
      identity,
      identityMode,
      isRequired,
      promptOpen,
      recoveryOpen,
      openPrompt,
      closePrompt,
      openRecovery,
      closeRecovery,
      register,
      recoverRequest,
      recoverVerify,
      forget,
      signOut,
      ensureIdentity,
    ]
  );

  return (
    <GuestIdentityContext.Provider value={value}>
      {/* Re-keyed on an identity switch so consumers holding local feedback
          state are rebuilt rather than showing the previous guest's. */}
      <React.Fragment key={identityGeneration}>{children}</React.Fragment>
    </GuestIdentityContext.Provider>
  );
};

export function useGuestIdentity(): GuestIdentityContextValue {
  const ctx = useContext(GuestIdentityContext);
  if (!ctx) {
    throw new Error('useGuestIdentity must be used within a GuestIdentityProvider');
  }
  return ctx;
}

/**
 * Safe hook that returns null if no provider is present. Useful when code
 * needs to optionally tie into guest identity without crashing when used
 * outside a gallery (e.g. in admin contexts).
 */
export function useGuestIdentityOptional(): GuestIdentityContextValue | null {
  return useContext(GuestIdentityContext);
}
