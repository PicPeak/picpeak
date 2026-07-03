import React, { createContext, useContext, useMemo, useState, useCallback, useEffect } from 'react';
import type { ReactNode } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { featureFlagsService, type FeatureFlags, type FeatureKey } from '../services/featureFlags.service';

export type { FeatureKey, FeatureFlags };

// Spec defaults — used as a non-blocking fallback while the network
// request is in flight, and as the source of truth for any flag the
// server doesn't return (e.g. a brand-new flag added in a release that
// hasn't run its migration yet on this instance).
export const DEFAULT_FLAGS: FeatureFlags = {
  galleries: true,
  // F.3 — these three are placeholders. The UI cards are locked
  // (lockedReason: NOT_YET_AVAILABLE) because the underlying flows
  // aren't implemented yet. Default FALSE so the toggle isn't
  // confusingly "on but locked".
  reminderEmails: false,
  calendar: false,
  calendarBooking: false,
  quotes: false,
  bills: false,
  messaging: false,
  // Incoming mail (migration 128) — IMAP intake. Standalone, default off.
  incomingMail: false,
  analytics: true,
  userManagement: true,
  // Top-level Clients section (#354 follow-up). Migration 097 mirrors
  // the install's current customerPortal value so admins who already
  // had the portal enabled keep seeing the section after upgrade.
  clients: false,
  // Customer portal (#354). Defaults OFF on a fresh install — picpeak
  // ships as a focused gallery delivery tool, recurring-customer
  // logins are opt-in. Migration 095 flips this to TRUE on existing
  // installs (events>0).
  customerPortal: false,
  // CRM developer tools sub-tab. Strictly opt-in.
  crmDevelopment: false,
  // Tax / Steuer report sub-tab. Independent toggle; forced off when
  // `bills` is off (no invoices → nothing to report).
  taxReport: false,
  // Hours logging master (migration 129). Off by default — admin
  // enables in Settings → Features once they're ready to surface the
  // per-customer Hours card.
  hoursLogging: false,
  // Contracts (migration 130). Off by default — admin enables in
  // Settings → Features once they've reviewed the seeded block
  // library with their lawyer.
  contracts: false,
  // Accounting (migration 122). Top-level MASTER for the Accounting
  // section (separate from CRM). Sub-features below require it.
  accounting: false,
  // Incoming invoices (migration 124) — external supplier-invoice capture +
  // re-bill. Accounting sub-feature; requires `accounting`.
  incomingInvoices: false,
  // Expenses (migration 127) — internal expenses (mileage / per-diem / cash).
  // Separate Accounting sub-feature; requires `accounting`.
  expenses: false,
  // Projects (migration 120). Admin-only grouping layer above events +
  // the Project Overview cockpit. Off by default — admin opts in under
  // Settings → Features once they want the CRM → Overview area.
  projects: false,
  // WhatsApp Business API delivery channel (migration 136, #640D).
  whatsapp: false,
  // Live Slideshow ("Diashow") — opt-in; gates all slideshow admin UI.
  slideshow: false,
  // Workflow / automation engine — opt-in; gates the Workflows admin area
  // and the engine runtime (triggers/actions/gates).
  workflows: false,
};

export const FEATURE_FLAGS_QUERY_KEY = ['feature-flags'] as const;

interface FeatureFlagsContextValue {
  // Live (saved) flags from the server. Never undefined — falls back to
  // DEFAULT_FLAGS while loading so consumers don't have to handle the
  // loading state for nav rendering.
  flags: FeatureFlags;
  // Staged (unsaved) flags. Same shape; equals `flags` when nothing is
  // pending.
  staged: FeatureFlags;
  isLoading: boolean;
  isSaving: boolean;
  isDirty: boolean;
  // Stage a single change locally. Enforces dependency rules
  // (quotes→bills, calendar→calendarBooking, galleries always true).
  setFlag: (key: FeatureKey, value: boolean) => void;
  // PUT all staged changes to the server.
  save: () => Promise<void>;
  // Revert staged → server-current.
  reset: () => void;
}

const FeatureFlagsContext = createContext<FeatureFlagsContextValue | undefined>(undefined);

function applyDependencyRules(flags: FeatureFlags): FeatureFlags {
  const out = { ...flags };
  out.galleries = true;                            // foundation — always on
  if (out.quotes === false) out.bills = false;     // bills depend on quotes
  if (out.calendar === false) out.calendarBooking = false;  // booking depends on calendar
  // Invoices (Bills) force-enable the Accounting master — invoice VAT config +
  // hourly rate live under Settings → Accounting. Before the accounting→children
  // rule so sub-features keep their own state.
  if (out.bills === true) out.accounting = true;
  // Accounting sub-features require the Accounting master. Tax export is
  // independent of Bills now — it relocated permanently into Accounting.
  if (out.accounting === false) {
    out.taxReport = false;
    out.incomingInvoices = false;
    out.expenses = false;
  }
  // Clients parent flag is DERIVED from its children. Admins don't
  // toggle it directly — enabling any CRM-area sub-feature
  // (Accounts today; future Calendar / Quotes / Bills / Messaging)
  // lights up the Clients sidebar section automatically, and
  // disabling all of them hides it again.
  out.clients = Boolean(
    out.customerPortal
    || out.crmDevelopment
    || out.quotes
    || out.bills
    || out.hoursLogging
    || out.contracts
    // Migration 137 — admin calendar lights up the Clients section.
    || out.calendar
    // NOTE: taxReport is intentionally NOT here anymore — the Tax export
    // moved permanently into the Accounting section (its own master).
    // future siblings: || out.messaging
  );
  return out;
}

/**
 * Flags whose customer-side surface only renders when the customer
 * portal is on. The FeaturesTab uses this to disable the toggle on
 * child cards when customerPortal=false (with a "requires Customer
 * portal" tooltip), so the admin doesn't flip something that has no
 * visible effect.
 */
export const CUSTOMER_PORTAL_DEPENDENT_FLAGS: FeatureKey[] = [
  'calendar', 'calendarBooking', 'quotes', 'bills', 'messaging',
];

function flagsEqual(a: FeatureFlags, b: FeatureFlags): boolean {
  return (Object.keys(a) as FeatureKey[]).every((k) => a[k] === b[k]);
}

interface ProviderProps {
  children: ReactNode;
}

export const FeatureFlagsProvider: React.FC<ProviderProps> = ({ children }) => {
  const queryClient = useQueryClient();
  const { data: serverFlags, isLoading } = useQuery<FeatureFlags>({
    queryKey: FEATURE_FLAGS_QUERY_KEY,
    queryFn: () => featureFlagsService.get(),
    staleTime: 60_000,
  });

  // Source-of-truth = server response; fall back to defaults during load.
  const flags = useMemo(() => serverFlags ?? DEFAULT_FLAGS, [serverFlags]);

  // Staged copy — what the Features tab is currently showing pre-save.
  const [staged, setStaged] = useState<FeatureFlags>(flags);

  // Re-sync staged whenever the server response arrives or refreshes,
  // unless the user has unsaved changes (which we'd silently overwrite
  // otherwise).
  useEffect(() => {
    setStaged((current) => {
      if (flagsEqual(current, flags)) return current;
      // If staged matches the OLD server state (no pending edits), accept
      // the new server state. Otherwise keep user's edits.
      // Detection: if every key is either equal to flags or differs only
      // because the user edited, we can't distinguish — so be conservative
      // and only auto-sync when the user hasn't touched anything.
      // Simplification: only replace staged on first load (when staged
      // still equals DEFAULT_FLAGS shape from the initial useState call).
      return current;
    });
  }, [flags]);

  // First-load wiring: when serverFlags arrives, seed `staged` once.
  useEffect(() => {
    if (serverFlags) {
      setStaged((current) => (flagsEqual(current, DEFAULT_FLAGS) ? serverFlags : current));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [Boolean(serverFlags)]);

  const isDirty = useMemo(() => !flagsEqual(staged, flags), [staged, flags]);

  const setFlag = useCallback((key: FeatureKey, value: boolean) => {
    if (key === 'galleries') return; // locked
    setStaged((prev) => applyDependencyRules({ ...prev, [key]: value }));
  }, []);

  const reset = useCallback(() => {
    setStaged(flags);
  }, [flags]);

  const mutation = useMutation({
    mutationFn: (next: FeatureFlags) => featureFlagsService.update(next),
    onSuccess: (saved) => {
      queryClient.setQueryData(FEATURE_FLAGS_QUERY_KEY, saved);
      setStaged(saved);
      // Also invalidate so any other consumer (e.g. AdminSidebar that
      // reads via the context) re-renders against fresh data.
      queryClient.invalidateQueries({ queryKey: FEATURE_FLAGS_QUERY_KEY });
    },
  });

  const save = useCallback(async () => {
    if (!isDirty) return;
    await mutation.mutateAsync(staged);
  }, [isDirty, mutation, staged]);

  const value = useMemo<FeatureFlagsContextValue>(
    () => ({
      flags,
      staged,
      isLoading,
      isSaving: mutation.isPending,
      isDirty,
      setFlag,
      save,
      reset,
    }),
    [flags, staged, isLoading, mutation.isPending, isDirty, setFlag, save, reset],
  );

  return <FeatureFlagsContext.Provider value={value}>{children}</FeatureFlagsContext.Provider>;
};

export function useFeatureFlags(): FeatureFlagsContextValue {
  const ctx = useContext(FeatureFlagsContext);
  if (!ctx) {
    throw new Error('useFeatureFlags must be used inside a FeatureFlagsProvider');
  }
  return ctx;
}

// Convenience hook for "is this feature enabled right now?" — returns
// the SAVED value, not the staged one (sidebar visibility shouldn't
// flip the moment someone toggles something on the Features page).
export function useFeatureEnabled(key: FeatureKey): boolean {
  const { flags } = useFeatureFlags();
  return flags[key];
}
