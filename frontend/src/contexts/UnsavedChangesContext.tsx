import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { matchPath, UNSAFE_DataRouterContext, useBlocker, useLocation, useNavigate } from 'react-router-dom';
import type { BlockerFunction } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useConfirm } from '../components/common/ConfirmDialog';

/**
 * One registry for "this page has unsaved edits" across the admin.
 *
 * A settings form registers its dirty flag (and how to discard) through
 * useUnsavedChanges — SettingsSaveBar does that for every tab that renders
 * it. While anything is dirty the tab-close / reload prompt is armed, and
 * in-app navigation asks before it throws the edits away.
 *
 * Two layers ask, and only ever one of them per attempt:
 *  - navigation entry points that go through useLeaveGuard (sidebar, header,
 *    command palette) ask before they navigate, and run the forms' discard;
 *  - a router blocker catches everything else — browser Back / Forward, a
 *    plain <Link>, a navigate() from anywhere. "Stay" restores the URL and
 *    the history position; "leave" goes on to the intended target. It does
 *    not run discard when the route is left: the form unmounts with it. (A
 *    discard that itself navigates — the "new document" editors — would
 *    fight the pending navigation.) Between two Settings tabs it does run
 *    it: SettingsPage stays mounted and holds drafts above its tabs. Any
 *    other page that survives a navigation must key its draft by the
 *    record, as EventDetailsPage does.
 *
 * The blocker needs a data router (App.tsx has one). Under a plain
 * <MemoryRouter> or no router at all — unit tests — only the first layer runs.
 */

interface Entry {
  isDirty: boolean;
  discard?: () => void;
}

interface UnsavedChangesContextValue {
  register: (id: string, entry: Entry) => void;
  unregister: (id: string) => void;
  isAnyDirty: boolean;
  /** Ask the user when something is dirty. Resolves true when it is safe to
   *  leave (nothing dirty, or the user chose to discard — in which case the
   *  forms' discard callbacks have run). */
  confirmLeave: () => Promise<boolean>;
  /** Run a navigation the router blocker must not question: the page's own
   *  Cancel / Discard, or the redirect after its record is gone. */
  unguarded: (fn: () => void) => void;
}

type Loc = { pathname: string; search: string };

// Matched the way the router matches the route: a trailing slash and another
// letter case reach SettingsPage as well.
const isSettings = (l: Loc) => matchPath('/admin/settings', l.pathname) !== null;

/** Settings tabs share one path, and each tab holds its own form. */
const settingsTab = (l: Loc) => (isSettings(l) ? new URLSearchParams(l.search).get('tab') : null);

/** From one Settings tab to another: SettingsPage itself stays mounted. */
const isSettingsTabChange = (from: Loc, to: Loc) =>
  isSettings(from) && isSettings(to) && settingsTab(from) !== settingsTab(to);

const LeaveBlocker: React.FC<{
  shouldBlock: BlockerFunction;
  ask: (signal?: AbortSignal) => Promise<boolean>;
  discardAll: () => void;
}> = ({ shouldBlock, ask, discardAll }) => {
  const blocker = useBlocker(shouldBlock);
  const location = useLocation();
  // One question per blocked navigation: `ask` may change identity between
  // renders (it follows the language) and must not ask again when it does.
  const askRef = useRef(ask);
  askRef.current = ask;
  const leaveRef = useRef({ location, discardAll });
  leaveRef.current = { location, discardAll };
  useEffect(() => {
    if (blocker.state !== 'blocked') return;
    // A second attempt while the dialog is open replaces the first: the
    // dialog resolves the superseded question as "stay", which must not
    // reset the newer block. The block can also end without an answer: a
    // navigation that needs no question (Back to an entry of this same page)
    // goes through and the router drops the held one. The question is
    // withdrawn then, or its dialog would stay open with nothing behind it.
    let superseded = false;
    const withdrawn = new AbortController();
    void askRef.current(withdrawn.signal).then((ok) => {
      if (superseded) return;
      if (!ok) { blocker.reset(); return; }
      // SettingsPage outlives its tabs and keeps some of their drafts: left
      // alone, the edits would be back on Forward.
      const { location: from, discardAll: discard } = leaveRef.current;
      if (blocker.location && isSettingsTabChange(from, blocker.location)) discard();
      blocker.proceed();
    });
    return () => { superseded = true; withdrawn.abort(); };
  }, [blocker]);
  return null;
};

const UnsavedChangesContext = createContext<UnsavedChangesContextValue | undefined>(undefined);

export const UnsavedChangesProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const entriesRef = useRef<Map<string, Entry>>(new Map());
  const [dirtyCount, setDirtyCount] = useState(0);

  const recount = useCallback(() => {
    let n = 0;
    for (const e of entriesRef.current.values()) if (e.isDirty) n += 1;
    setDirtyCount(n);
  }, []);

  const register = useCallback((id: string, entry: Entry) => {
    entriesRef.current.set(id, entry);
    recount();
  }, [recount]);

  const unregister = useCallback((id: string) => {
    entriesRef.current.delete(id);
    recount();
  }, [recount]);

  const isAnyDirty = dirtyCount > 0;

  useEffect(() => {
    if (!isAnyDirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [isAnyDirty]);

  const ask = useCallback((signal?: AbortSignal) => confirm({
    title: t('settings.saveBar.leaveTitle', 'Discard unsaved changes?'),
    message: t('settings.saveBar.leaveMessage', 'You have unsaved changes on this page. Leaving now discards them.'),
    confirmLabel: t('settings.saveBar.leaveConfirm', 'Discard and leave'),
    cancelLabel: t('settings.saveBar.leaveCancel', 'Stay'),
    variant: 'warning',
    signal,
  }), [confirm, t]);

  // True while a navigation is under way that has already been answered for.
  const skipBlockerRef = useRef(false);

  const discardAll = useCallback(() => {
    for (const e of entriesRef.current.values()) if (e.isDirty) e.discard?.();
  }, []);

  const confirmLeave = useCallback(async () => {
    let dirty = false;
    for (const e of entriesRef.current.values()) if (e.isDirty) dirty = true;
    if (!dirty) return true;
    if (!(await ask())) return false;
    // The caller navigates next, in this same task, and the forms may still
    // read dirty by then: the blocker must not ask a second time. Set before
    // the discards run, because a discard may navigate itself.
    skipBlockerRef.current = true;
    setTimeout(() => { skipBlockerRef.current = false; }, 0);
    discardAll();
    return true;
  }, [ask, discardAll]);

  const unguarded = useCallback((fn: () => void) => {
    const before = skipBlockerRef.current;
    skipBlockerRef.current = true;
    try { fn(); } finally { skipBlockerRef.current = before; }
  }, []);

  const shouldBlock = useCallback<BlockerFunction>(({ currentLocation, nextLocation }) => {
    if (skipBlockerRef.current) return false;
    let dirty = false;
    for (const e of entriesRef.current.values()) if (e.isDirty) dirty = true;
    if (!dirty) return false;
    // A page syncing its own ?tab= / ?section= keeps its form mounted.
    if (isSettings(currentLocation) && isSettings(nextLocation)) {
      return settingsTab(currentLocation) !== settingsTab(nextLocation);
    }
    return currentLocation.pathname !== nextLocation.pathname;
  }, []);

  const value = useMemo(
    () => ({ register, unregister, isAnyDirty, confirmLeave, unguarded }),
    [register, unregister, isAnyDirty, confirmLeave, unguarded]
  );

  const hasDataRouter = useContext(UNSAFE_DataRouterContext) !== null;

  return (
    <UnsavedChangesContext.Provider value={value}>
      {hasDataRouter && <LeaveBlocker shouldBlock={shouldBlock} ask={ask} discardAll={discardAll} />}
      {children}
    </UnsavedChangesContext.Provider>
  );
};

let nextId = 0;

/**
 * Register a form's dirty state. Safe to call outside the provider (public
 * pages, tests): it then does nothing.
 */
export function useUnsavedChanges(isDirty: boolean, discard?: () => void): void {
  const ctx = useContext(UnsavedChangesContext);
  const idRef = useRef<string>('');
  if (!idRef.current) idRef.current = `form-${++nextId}`;
  const discardRef = useRef(discard);
  discardRef.current = discard;

  useEffect(() => {
    if (!ctx) return;
    const id = idRef.current;
    ctx.register(id, { isDirty, discard: () => discardRef.current?.() });
    return () => ctx.unregister(id);
  }, [ctx, isDirty]);
}

/**
 * onClick for an in-app link that leaves the page. Lets the link navigate on
 * its own when nothing is dirty or the click opens another tab (Cmd/Ctrl,
 * Shift, middle button — this form stays where it is); otherwise asks first.
 * `after` runs whenever the navigation goes ahead (e.g. close a drawer).
 */
export function useGuardedLinkClick(): (
  e: React.MouseEvent,
  href: string,
  opts?: { replace?: boolean; after?: () => void },
) => void {
  const { confirmLeave, isAnyDirty } = useLeaveGuard();
  const navigate = useNavigate();
  return (e, href, opts = {}) => {
    const modified = e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0;
    if (!isAnyDirty || modified) { opts.after?.(); return; }
    e.preventDefault();
    void confirmLeave().then((ok) => {
      if (!ok) return;
      opts.after?.();
      navigate(href, { replace: !!opts.replace });
    });
  };
}

const runNow = (fn: () => void) => fn();

/**
 * For navigation entry points: `if (await confirmLeave()) navigate(to)`.
 * `unguarded(() => navigate(to))` is for a page's own Cancel / Discard and
 * for the redirect after its record is gone: it leaves without a question.
 */
export function useLeaveGuard(): {
  confirmLeave: () => Promise<boolean>;
  isAnyDirty: boolean;
  unguarded: (fn: () => void) => void;
} {
  const ctx = useContext(UnsavedChangesContext);
  return {
    confirmLeave: ctx ? ctx.confirmLeave : async () => true,
    isAnyDirty: ctx ? ctx.isAnyDirty : false,
    unguarded: ctx ? ctx.unguarded : runNow,
  };
}
