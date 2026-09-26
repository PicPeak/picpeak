import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useConfirm } from '../components/common/ConfirmDialog';

/**
 * One registry for "this page has unsaved edits" across the admin.
 *
 * A settings form registers its dirty flag (and how to discard) through
 * useUnsavedChanges — SettingsSaveBar does that for every tab that renders
 * it. While anything is dirty the tab-close / reload prompt is armed, and
 * in-app navigation that goes through useLeaveGuard (sidebar, header) asks
 * before it throws the edits away.
 *
 * There is no router-level blocker: the admin runs on <BrowserRouter>, which
 * has none, so the guard sits on the navigation entry points instead.
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
}

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

  const confirmLeave = useCallback(async () => {
    let dirty = false;
    for (const e of entriesRef.current.values()) if (e.isDirty) dirty = true;
    if (!dirty) return true;
    const ok = await confirm({
      title: t('settings.saveBar.leaveTitle', 'Discard unsaved changes?'),
      message: t('settings.saveBar.leaveMessage', 'You have unsaved changes on this page. Leaving now discards them.'),
      confirmLabel: t('settings.saveBar.leaveConfirm', 'Discard and leave'),
      cancelLabel: t('settings.saveBar.leaveCancel', 'Stay'),
      variant: 'warning',
    });
    if (!ok) return false;
    for (const e of entriesRef.current.values()) if (e.isDirty) e.discard?.();
    return true;
  }, [confirm, t]);

  const value = useMemo(
    () => ({ register, unregister, isAnyDirty, confirmLeave }),
    [register, unregister, isAnyDirty, confirmLeave]
  );

  return <UnsavedChangesContext.Provider value={value}>{children}</UnsavedChangesContext.Provider>;
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

/** For navigation entry points: `if (await confirmLeave()) navigate(to)`. */
export function useLeaveGuard(): { confirmLeave: () => Promise<boolean>; isAnyDirty: boolean } {
  const ctx = useContext(UnsavedChangesContext);
  return {
    confirmLeave: ctx ? ctx.confirmLeave : async () => true,
    isAnyDirty: ctx ? ctx.isAnyDirty : false,
  };
}
