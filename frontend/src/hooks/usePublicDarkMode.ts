/**
 * usePublicDarkMode — toggle the `.dark` class on <html> based on
 * the admin's branding settings, for public pages that live outside
 * the admin/customer layouts.
 *
 * Priority:
 *   1. `branding_force_color_mode` → 'dark' / 'light' / null
 *   2. fallback to the OS preference (and react when it flips)
 *
 * Necessary because Tailwind's `dark:` modifiers depend on the
 * `.dark` class being present, and ThemeContext only writes CSS
 * variables — it doesn't toggle the class.
 *
 * Shared by QuoteResponsePage + PaymentCheckPage. Adding a third
 * public-page consumer? Reuse this hook.
 */
import { useEffect, useState } from 'react';
import { usePublicSettings } from './usePublicSettings';

/**
 * Returns `{ isDark }` (reactive) in addition to applying the `.dark`
 * class, so callers can pick a theme-aware asset (e.g. the dark-mode
 * logo) without re-deriving the mode themselves.
 */
export function usePublicDarkMode(): { isDark: boolean } {
  const { data: publicSettings } = usePublicSettings();
  const forced = publicSettings?.branding_force_color_mode;
  const [isDark, setIsDark] = useState<boolean>(() => {
    if (forced === 'dark') return true;
    if (forced === 'light') return false;
    return typeof window !== 'undefined'
      && window.matchMedia('(prefers-color-scheme: dark)').matches;
  });
  useEffect(() => {
    const root = document.documentElement;
    const apply = (dark: boolean) => {
      setIsDark(dark);
      if (dark) root.classList.add('dark');
      else root.classList.remove('dark');
    };
    if (forced === 'dark') {
      apply(true);
      return;
    }
    if (forced === 'light') {
      apply(false);
      return;
    }
    const mql = window.matchMedia('(prefers-color-scheme: dark)');
    apply(mql.matches);
    const listener = (e: MediaQueryListEvent) => apply(e.matches);
    mql.addEventListener('change', listener);
    return () => mql.removeEventListener('change', listener);
  }, [forced]);
  return { isDark };
}
