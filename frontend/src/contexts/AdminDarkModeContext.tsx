import React, { createContext, useContext, useState, useEffect, useCallback, useMemo } from 'react';
import { useLocation } from 'react-router-dom';
import { usePublicSettings } from '../hooks/usePublicSettings';

type DarkModePreference = 'light' | 'dark' | 'system';

interface AdminDarkModeContextType {
  preference: DarkModePreference;
  isDark: boolean;
  /**
   * When the admin has set `branding_force_color_mode`, the toggle is locked
   * to that value. Consumers (AdminHeader) hide their toggle when this is
   * truthy — UI parity with the user's "disable lightmode option page wide"
   * request from discussion #397.
   */
  forcedMode: 'dark' | 'light' | null;
  setPreference: (pref: DarkModePreference) => void;
  toggle: () => void;
}

const AdminDarkModeContext = createContext<AdminDarkModeContextType | undefined>(undefined);

const STORAGE_KEY = 'admin-dark-mode';

function resolveIsDark(pref: DarkModePreference): boolean {
  if (pref === 'dark') return true;
  if (pref === 'light') return false;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

export const AdminDarkModeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const location = useLocation();
  const isLoginPage = location.pathname === '/admin/login';

  // Instance-wide force mode (read from branding settings). When set, this
  // wins over user preference and system preference. Refetches every 30s so
  // toggling it in the Branding tab propagates to other open tabs without
  // needing a full reload.
  const { data: publicSettings } = usePublicSettings({ refetchInterval: 30_000 });
  const forcedMode: 'dark' | 'light' | null = publicSettings?.branding_force_color_mode === 'dark'
    ? 'dark'
    : publicSettings?.branding_force_color_mode === 'light'
      ? 'light'
      : null;

  const [preference, setPreferenceState] = useState<DarkModePreference>(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'dark' || stored === 'light' || stored === 'system') return stored;
    return 'light';
  });

  // The effective dark state: if a force mode is set, that wins; otherwise
  // we resolve from the user's preference (light / dark / system).
  const [isDark, setIsDark] = useState(() => resolveIsDark(preference));

  const applyDarkClass = useCallback((dark: boolean, forceLight = false) => {
    const root = document.documentElement;
    if (dark && !forceLight) {
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
    }
  }, []);

  const setPreference = useCallback((pref: DarkModePreference) => {
    // If an admin has locked the instance to a specific mode, the user
    // toggle is a no-op — silently ignore so we don't desync the UI.
    if (forcedMode) return;
    setPreferenceState(pref);
    localStorage.setItem(STORAGE_KEY, pref);
    const dark = resolveIsDark(pref);
    setIsDark(dark);
    // Don't apply dark on login page
    applyDarkClass(dark, isLoginPage);
  }, [applyDarkClass, isLoginPage, forcedMode]);

  const toggle = useCallback(() => {
    if (forcedMode) return;
    setPreference(isDark ? 'light' : 'dark');
  }, [isDark, setPreference, forcedMode]);

  // Apply on mount and when route or force mode changes. The force-mode
  // branch wins, then per-route login override, then user preference.
  useEffect(() => {
    if (forcedMode) {
      const dark = forcedMode === 'dark';
      setIsDark(dark);
      applyDarkClass(dark, isLoginPage && forcedMode === 'light');
      return;
    }
    applyDarkClass(isDark, isLoginPage);
  }, [applyDarkClass, isDark, isLoginPage, forcedMode]);

  // Listen for system changes when preference is 'system' (and no force mode)
  useEffect(() => {
    if (forcedMode || preference !== 'system') return;

    const mql = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = (e: MediaQueryListEvent) => {
      setIsDark(e.matches);
      applyDarkClass(e.matches);
    };
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, [preference, applyDarkClass, forcedMode]);

  // Strip dark class when unmounting (navigating away from admin)
  useEffect(() => {
    return () => {
      document.documentElement.classList.remove('dark');
    };
  }, []);

  const value = useMemo(
    () => ({ preference, isDark, forcedMode, setPreference, toggle }),
    [preference, isDark, forcedMode, setPreference, toggle]
  );

  return (
    <AdminDarkModeContext.Provider value={value}>
      {children}
    </AdminDarkModeContext.Provider>
  );
};

export const useAdminDarkMode = () => {
  const context = useContext(AdminDarkModeContext);
  if (!context) {
    throw new Error('useAdminDarkMode must be used within AdminDarkModeProvider');
  }
  return context;
};
