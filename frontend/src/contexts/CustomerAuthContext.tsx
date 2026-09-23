/**
 * Customer-side React auth context (#354).
 *
 * Sibling of AdminAuthContext / GalleryAuthContext but operates on a
 * separate cookie (customer_token) and a separate API surface
 * (/api/customer/auth/*). The contexts are isolated by design so that
 * a single browser can hold an admin session AND a customer session
 * without one clobbering the other (e.g. for the admin dogfooding the
 * customer dashboard).
 *
 * #354 follow-up: also surfaces the effective feature set and the
 * branding visibility flags so CustomerLayout can render the sidebar
 * without an extra round trip on every navigation.
 */
import React, { createContext, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import i18n from '../i18n/config';
import { customerService, type CustomerProfile } from '../services/customer.service';

/**
 * Query key names owned by the customer portal (frontend/src/pages/customer/*),
 * cleared on logout / session-loss (#1594) so the next customer to sign in
 * on the same device never briefly sees the previous one's cached dashboard,
 * quotes, contracts or invoices.
 *
 * Not a blanket `queryKey[0].startsWith('customer')` predicate: the app's
 * QueryClient is a single instance shared with the admin dashboard (see
 * App.tsx), and the admin CRM panels (CustomerCrmPanels.tsx, HoursSection.tsx)
 * reuse the exact same first-element strings — 'customer-quotes',
 * 'customer-contracts', 'customer-invoices' — for a *different*, per-account
 * cache shaped `['customer-quotes', customerAccountId]`. Per this file's own
 * header comment, an admin session and a customer session can coexist in the
 * same browser, so that admin cache must survive a customer-portal logout.
 * The three overlapping names are only cleared when the key has no second
 * element (the shape the portal itself uses); every other portal key name is
 * unique and clears regardless of length.
 */
const PORTAL_ONLY_QUERY_KEYS = new Set([
  'customer-events',
  'customer-profile',
  'customer-quote',
  'customer-contract',
]);
const PORTAL_SHARED_NAME_QUERY_KEYS = new Set([
  'customer-quotes',
  'customer-contracts',
  'customer-invoices',
]);

function clearCustomerPortalQueryCache(queryClient: QueryClient) {
  queryClient.removeQueries({
    predicate: (query) => {
      const name = query.queryKey[0];
      if (typeof name !== 'string') return false;
      if (PORTAL_ONLY_QUERY_KEYS.has(name)) return true;
      if (PORTAL_SHARED_NAME_QUERY_KEYS.has(name)) return query.queryKey.length === 1;
      return false;
    },
  });
}

/**
 * Apply a customer's preferred language to the portal UI. The admin-set
 * `preferred_language` already drives PDF rendering and queued email
 * locale resolution; this closes the third surface so the portal UI
 * actually honours the same setting. Swallows errors because i18n init
 * can race with the auth flow — failing to switch language must never
 * break login. Pattern lifted from QuoteResponsePage.tsx.
 */
function applyCustomerLocale(lang?: string | null) {
  if (!lang) return;
  if (lang === i18n.language) return;
  i18n.changeLanguage(lang).catch(() => {});
}

export interface CustomerFeatureFlags {
  calendar: boolean;
  quotes: boolean;
  bills: boolean;
  contracts: boolean;
}

export interface CustomerBrandingFlags {
  showLogo: boolean;
  showCompanyName: boolean;
}

interface CustomerAuthContextType {
  isAuthenticated: boolean;
  customer: CustomerProfile | null;
  features: CustomerFeatureFlags;
  branding: CustomerBrandingFlags;
  isLoading: boolean;
  error: string | null;
  /** Replaces the cached profile after a successful POST /login. */
  setCustomer: (c: CustomerProfile) => void;
  /**
   * Replaces customer + features + branding atomically. Used by the
   * login page so the dashboard's first paint after login shows the
   * correct sidebar (without this, features default to `false` and the
   * Soon menus would only appear after the next CustomerAuthProvider
   * re-mount, e.g. after navigating to a gallery and back).
   */
  setSession: (s: { customer: CustomerProfile; features: CustomerFeatureFlags; branding: CustomerBrandingFlags }) => void;
  logout: () => Promise<void>;
}

const CustomerAuthContext = createContext<CustomerAuthContextType | undefined>(undefined);

export const useCustomerAuth = () => {
  const ctx = useContext(CustomerAuthContext);
  if (!ctx) {
    throw new Error('useCustomerAuth must be used within a CustomerAuthProvider');
  }
  return ctx;
};

const STORAGE_KEY = 'customer_profile';
const FEATURES_KEY = 'customer_features';
const BRANDING_KEY = 'customer_branding';

const DEFAULT_FEATURES: CustomerFeatureFlags = { calendar: false, quotes: false, bills: false, contracts: false };
const DEFAULT_BRANDING: CustomerBrandingFlags = { showLogo: true, showCompanyName: true };

interface ProviderProps { children: ReactNode; }

export const CustomerAuthProvider: React.FC<ProviderProps> = ({ children }) => {
  const queryClient = useQueryClient();
  const [customer, setCustomerState] = useState<CustomerProfile | null>(null);
  const [features, setFeatures] = useState<CustomerFeatureFlags>(DEFAULT_FEATURES);
  const [branding, setBranding] = useState<CustomerBrandingFlags>(DEFAULT_BRANDING);
  const [isLoading, setIsLoading] = useState(true);
  // Reserved for future surface-level errors (login form errors are
  // handled inline on the login page itself, not here).
  const [error] = useState<string | null>(null);
  // Tracks the last-rendered customer id outside React state so refreshSession
  // (a stable useCallback, not recreated per render) can always compare
  // against the *current* identity rather than a stale closure over `customer`.
  const customerIdRef = React.useRef<CustomerProfile['id'] | null>(null);

  /**
   * Refetch the session from /api/customer/auth/session and update both
   * React state and sessionStorage caches. Called on initial mount AND
   * on window focus, so an admin who toggles a per-customer feature in
   * one tab sees the change reflected in the customer tab the moment
   * they switch back. Without this, the layout reads only from the
   * mount-time sessionStorage cache and stays stale until a hard reload.
   */
  const refreshSession = React.useCallback(async () => {
    // Contract (see customerService.session()):
    //   - object → fresh data, store it.
    //   - null   → server says we're explicitly logged out (401);
    //              clear local state.
    //   - throw  → transient error (network blip, 5xx, timeout).
    //              KEEP whatever state we have — logging the user out
    //              on a flaky network call is the wrong default. The
    //              old code clobbered local state on any error, which
    //              caused mysterious "customer keeps getting kicked
    //              out" reports during unrelated admin saves and on
    //              brief connection drops.
    let response: Awaited<ReturnType<typeof customerService.session>>;
    try {
      response = await customerService.session();
    } catch (err) {
      // Transient. Don't touch state. The next focus/visibility tick
      // will retry; if the customer really is unauthenticated the
      // retry will see the 401 and clear properly.
      // eslint-disable-next-line no-console
      console.warn('[CustomerAuth] session refresh failed transiently, keeping current state', err);
      return;
    }
    if (response?.customer) {
      // customer_token is a single domain-wide cookie (see
      // customer.service.ts), so a second tab can log out customer A and
      // log in as customer B while this tab stays open. That tab's next
      // refreshSession() gets a plain 200 for customer B — never a 401 —
      // so without this check the else-branch cache clear below never
      // runs and customer A's cached dashboard/quotes/contracts/invoices
      // can render labeled as customer B's session (#1594). Also fires on
      // a fresh login (previous id null); harmless since there's nothing
      // stale to leak yet.
      if (customerIdRef.current !== response.customer.id) {
        clearCustomerPortalQueryCache(queryClient);
      }
      customerIdRef.current = response.customer.id;
      setCustomerState(response.customer);
      setFeatures(response.features);
      setBranding(response.branding);
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(response.customer));
      sessionStorage.setItem(FEATURES_KEY, JSON.stringify(response.features));
      sessionStorage.setItem(BRANDING_KEY, JSON.stringify(response.branding));
      applyCustomerLocale(response.customer.preferredLanguage);
    } else {
      // Explicit 401 — server says no (session revoked, or an
      // erasure-forced logout). The SPA stays mounted here (no hard
      // navigation), so a cached dashboard/quotes/contracts/invoices query
      // from this customer would otherwise sit in the QueryClient and flash
      // on screen the moment the next customer logs in on the same device.
      customerIdRef.current = null;
      setCustomerState(null);
      sessionStorage.removeItem(STORAGE_KEY);
      sessionStorage.removeItem(FEATURES_KEY);
      sessionStorage.removeItem(BRANDING_KEY);
      clearCustomerPortalQueryCache(queryClient);
    }
  }, [queryClient]);

  useEffect(() => {
    // Hydrate immediately from sessionStorage so the dashboard avoids
    // a flicker on hard refresh; the network call below confirms the
    // cookie is still valid and overwrites stale data.
    try {
      const cached = sessionStorage.getItem(STORAGE_KEY);
      if (cached) {
        const parsed = JSON.parse(cached) as CustomerProfile;
        setCustomerState(parsed);
        // Apply the cached locale immediately so a hard refresh doesn't
        // flash the default language before refreshSession lands.
        applyCustomerLocale(parsed.preferredLanguage);
      }
      const cachedFeatures = sessionStorage.getItem(FEATURES_KEY);
      if (cachedFeatures) setFeatures(JSON.parse(cachedFeatures));
      const cachedBranding = sessionStorage.getItem(BRANDING_KEY);
      if (cachedBranding) setBranding(JSON.parse(cachedBranding));
    } catch {
      sessionStorage.removeItem(STORAGE_KEY);
      sessionStorage.removeItem(FEATURES_KEY);
      sessionStorage.removeItem(BRANDING_KEY);
    }

    let cancelled = false;
    refreshSession().finally(() => {
      if (!cancelled) setIsLoading(false);
    });

    // Refetch on tab/window focus so admin-side changes (per-customer
    // feature toggles, branding visibility, deactivation) reach the
    // customer browser without requiring a manual page reload.
    const onFocus = () => { void refreshSession(); };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void refreshSession();
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibility);

    // Periodic background refresh — covers the case where the customer
    // tab stays foregrounded for a long stretch (no focus/visibility
    // events fire) but admin has flipped a global toggle in another
    // browser. 60 seconds matches the usePublicSettings react-query
    // staleTime so branding + feature flags stay roughly in sync.
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refreshSession();
    }, 60_000);

    return () => {
      cancelled = true;
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibility);
      window.clearInterval(interval);
    };
  }, [refreshSession]);

  // Same identity check as refreshSession's success branch: a direct A→B
  // switch through setSession/setCustomer (a login without an intervening
  // logout or 401) must not keep A's cached portal queries around.
  const adoptCustomerId = (id: CustomerProfile['id']) => {
    if (customerIdRef.current !== id) {
      clearCustomerPortalQueryCache(queryClient);
    }
    customerIdRef.current = id;
  };

  const setCustomer = (c: CustomerProfile) => {
    adoptCustomerId(c.id);
    setCustomerState(c);
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(c));
    applyCustomerLocale(c.preferredLanguage);
  };

  const setSession = (s: { customer: CustomerProfile; features: CustomerFeatureFlags; branding: CustomerBrandingFlags }) => {
    adoptCustomerId(s.customer.id);
    setCustomerState(s.customer);
    setFeatures(s.features);
    setBranding(s.branding);
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(s.customer));
    sessionStorage.setItem(FEATURES_KEY, JSON.stringify(s.features));
    sessionStorage.setItem(BRANDING_KEY, JSON.stringify(s.branding));
    applyCustomerLocale(s.customer.preferredLanguage);
  };

  const logout = async () => {
    await customerService.logout();
    customerIdRef.current = null;
    setCustomerState(null);
    setFeatures(DEFAULT_FEATURES);
    setBranding(DEFAULT_BRANDING);
    sessionStorage.removeItem(STORAGE_KEY);
    sessionStorage.removeItem(FEATURES_KEY);
    sessionStorage.removeItem(BRANDING_KEY);
    // Defense in depth: the hard navigate below already discards this tab's
    // QueryClient, but clear explicitly in case that ever changes (#1594).
    clearCustomerPortalQueryCache(queryClient);
    // Hard navigate so any in-flight requests with the old cookie don't
    // race the cleared session — same approach AdminAuthContext uses.
    window.location.href = '/customer/login';
  };

  return (
    <CustomerAuthContext.Provider
      value={{
        isAuthenticated: !!customer,
        customer,
        features,
        branding,
        isLoading,
        error,
        setCustomer,
        setSession,
        logout,
      }}
    >
      {children}
    </CustomerAuthContext.Provider>
  );
};
