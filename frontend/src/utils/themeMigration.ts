import type { ThemeConfig } from '../types/theme.types';

/**
 * Surface defaults for the two color modes — the same values applyTheme()
 * falls back to when a theme has no explicit surface/elevated/border/text
 * tokens. Exposed here so the force-color-mode helper can swap them
 * wholesale when an admin locks the instance to a mode that the active
 * theme doesn't natively support.
 */
export const DARK_SURFACE_DEFAULTS = {
  backgroundColor: '#0f0f0f',
  surfaceColor: '#1a1a1a',
  elevatedColor: '#242424',
  surfaceBorderColor: '#2e2e2e',
  textColor: '#e5e5e5',
  mutedTextColor: '#a3a3a3',
};

export const LIGHT_SURFACE_DEFAULTS = {
  backgroundColor: '#fafafa',
  surfaceColor: '#ffffff',
  elevatedColor: '#f5f5f5',
  surfaceBorderColor: '#e5e5e5',
  textColor: '#171717',
  mutedTextColor: '#737373',
};

/**
 * Apply an instance-wide force color mode lock to a theme config.
 *
 * If the theme already matches the locked mode (or no lock is set), only
 * the colorMode flag is pinned. If the theme is locked to a mode it
 * doesn't natively support (e.g. an admin set Force Dark but is opening
 * a light gallery preset), the surface/text tokens are replaced with the
 * matching mode's defaults — the user's accent/accentDark colours are
 * preserved so brand identity survives the flip.
 *
 * Centralised here so GlobalThemeProvider, GalleryPage and GalleryView
 * stay in sync (#397 follow-up: galleries did not visibly flip when
 * Force Dark/Light was toggled because only colorMode was overridden,
 * leaving the original light/dark surface colours in place).
 */
export function applyForceColorMode(
  theme: ThemeConfig,
  forced: 'dark' | 'light' | null | undefined
): ThemeConfig {
  if (!forced) return theme;

  const themeMode = theme.colorMode === 'auto'
    ? (typeof window !== 'undefined'
        && window.matchMedia('(prefers-color-scheme: dark)').matches
          ? 'dark'
          : 'light')
    : (theme.colorMode || 'light');

  if (themeMode === forced) {
    return { ...theme, colorMode: forced };
  }

  const surfaces = forced === 'dark' ? DARK_SURFACE_DEFAULTS : LIGHT_SURFACE_DEFAULTS;
  return {
    ...theme,
    ...surfaces,
    colorMode: forced,
  };
}
