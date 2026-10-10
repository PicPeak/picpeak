/**
 * usePublicDarkMode — puts the operator's palette in charge of the customer
 * portal and the public pages (quote, contract, payment check, client
 * access, transfers, legal pages).
 *
 * While a page that calls it is mounted, <html> carries:
 *
 *   - `.public-ui`: tokens.css maps the UI tokens (--ui-panel, --ui-text-body,
 *     --ui-line, ...) onto the operator's theme tokens (--color-*). The shared
 *     primitives (Notice, EmptyState, ErrorState, Modal, ConfirmDialog, Card,
 *     Input) and the status utilities then sit on the operator's surface
 *     instead of the admin's grey, dialogs portalled to <body> included.
 *   - `.dark` when — and only when — the palette ThemeContext applied is a
 *     dark one. The dark status shades (lighter text, stronger tints) follow.
 *
 * Both classes come off again when the last such page unmounts, so leaving
 * the portal for the admin or a gallery leaves nothing behind.
 *
 * Before: the mode came from Branding's force-colour-mode or, failing that,
 * the visitor's OS preference — never from the palette itself. A light
 * palette seen from a dark-mode OS got `.dark` anyway, and every `.dark`
 * rule (the dark UI tokens, `.dark .input-themed`, `.dark :where(select)`,
 * the inert `dark:` variants) painted neutral greys over the operator's
 * colours. The class also stayed on <html> after unmount, so the quote and
 * contract views embedded in the portal (CustomerQuoteRespondPage,
 * CustomerContractSignPage) left it on every portal page visited after them.
 *
 * Returns `{ isDark }` so callers can pick the dark-mode logo.
 */
import { useEffect, useState } from 'react';
import { usePublicSettings } from './usePublicSettings';
import { useOptionalTheme } from '../contexts/ThemeContext';
import type { ThemeConfig } from '../types/theme.types';
import { applyForceColorMode } from '../utils/themeMigration';
import { isDarkBackground } from '../utils/contrast';

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

/**
 * Is the palette ThemeContext applies a dark one? Read from the colours
 * themselves (the page background, else the surface) after Branding's
 * force-colour-mode is applied, the same way applyTheme() applies it; the
 * theme's `colorMode` only decides when the theme names no colour.
 */
export function isPaletteDark(
  theme: ThemeConfig | undefined,
  forced: 'dark' | 'light' | null,
  osDark: boolean,
): boolean {
  if (!theme) return forced ? forced === 'dark' : osDark;
  const effective = applyForceColorMode(theme, forced);
  const colour = [effective.backgroundColor, effective.surfaceColor].find((c) => c && HEX.test(c.trim()));
  if (colour) return isDarkBackground(colour.trim());
  if (effective.colorMode === 'dark') return true;
  if (effective.colorMode === 'auto') return osDark;
  return false;
}

// How many mounted pages hold the classes, and what <html> had before the
// first of them, so two holders (the portal layout and an embedded quote
// view) don't strip each other's classes.
let holders = 0;
let hadDarkBefore = false;

function prefersDark(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

export function usePublicDarkMode(): { isDark: boolean } {
  const { data: publicSettings } = usePublicSettings();
  const theme = useOptionalTheme()?.theme;
  const forcedSetting = publicSettings?.branding_force_color_mode;
  const forced = forcedSetting === 'dark' || forcedSetting === 'light' ? forcedSetting : null;

  const [osDark, setOsDark] = useState<boolean>(prefersDark);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia('(prefers-color-scheme: dark)');
    const listener = (e: MediaQueryListEvent) => setOsDark(e.matches);
    mql.addEventListener('change', listener);
    return () => mql.removeEventListener('change', listener);
  }, []);

  const isDark = isPaletteDark(theme, forced, osDark);

  // Hold `.public-ui` for as long as the page is mounted.
  useEffect(() => {
    const root = document.documentElement;
    // A public page never mounts beside the admin (whose provider removes
    // .dark on unmount), so this is false in practice; it is kept so a
    // future caller inside another .dark owner gets its class back.
    if (holders === 0) hadDarkBefore = root.classList.contains('dark');
    holders += 1;
    root.classList.add('public-ui');
    return () => {
      holders -= 1;
      if (holders === 0) {
        root.classList.remove('public-ui');
        root.classList.toggle('dark', hadDarkBefore);
      }
    };
  }, []);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', isDark);
  }, [isDark]);

  return { isDark };
}
