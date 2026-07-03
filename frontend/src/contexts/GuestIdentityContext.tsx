import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { guestsService, GuestIdentity } from '../services/guests.service';
import {
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

  // When an invite token is present on the URL (?invite=xxx), redeem it once
  // on mount. The server returns a guest token we can persist.
  useEffect(() => {
    if (identityMode !== 'guest' || identity) return;
    const params = new URLSearchParams(window.location.search);
    const inviteToken = params.get('invite');
    if (!inviteToken) return;

    (async () => {
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
      }
    })();
  }, [slug, identityMode, identity]);

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

  const ensureIdentity = useCallback((): Promise<GuestIdentity> => {
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
    if (identity) return Promise.resolve(identity);

    return new Promise((resolve, reject) => {
      pendingResolvers.current.push(resolve);
      pendingRejecters.current.push(reject);
      setPromptOpen(true);
    });
  }, [identityMode, identity]);

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
      ensureIdentity,
    ]
  );

  return <GuestIdentityContext.Provider value={value}>{children}</GuestIdentityContext.Provider>;
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
