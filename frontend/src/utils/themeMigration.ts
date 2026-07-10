import type { ThemeConfig, HeaderStyleType, HeroDividerStyle, GalleryLayoutType } from '../types/theme.types';

/**
 * Surface defaults for the two color modes — the same values applyTheme()
 * falls back to when a theme has no explicit surface/elevated/border/text
 * tokens. Exposed here so the force-color-mode helper can swap them
 * wholesale when an admin locks the instance to a mode that the active
 * theme doesn't natively support.
 */
const DARK_SURFACE_DEFAULTS = {
  backgroundColor: '#0f0f0f',
  surfaceColor: '#1a1a1a',
  elevatedColor: '#242424',
  surfaceBorderColor: '#2e2e2e',
  textColor: '#e5e5e5',
  mutedTextColor: '#a3a3a3',
};

const LIGHT_SURFACE_DEFAULTS = {
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

/**
 * Fills in any missing 8-token CI palette fields on legacy themes that were
 * saved before the palette expanded from 4 → 8 explicit tokens.
 *
 * The visible look of an existing instance must not change just because the
 * type system grew (per project memory: migrations preserve visual state).
 * For each missing token we fall back to the value the renderer was already
 * deriving implicitly:
 *   - accentDarkColor   ← primaryColor (legacy primary was used as CTA fill)
 *   - elevatedColor     ← surfaceColor (or a slight shift for light themes)
 *   - surfaceColor      ← '#ffffff' / '#1a1a1a' depending on colorMode
 *   - surfaceBorderColor← '#e5e5e5' / '#2e2e2e'
 *   - mutedTextColor    ← '#737373' / '#a3a3a3'
 */
function fillMissingPaletteTokens(theme: ThemeConfig): ThemeConfig {
  const isDark = theme.colorMode === 'dark';
  const filled: ThemeConfig = { ...theme };

  if (!filled.surfaceColor) {
    filled.surfaceColor = isDark ? '#1a1a1a' : '#ffffff';
  }
  if (!filled.elevatedColor) {
    // For dark themes raise slightly above surface; for light, drop slightly below.
    filled.elevatedColor = isDark ? '#242424' : '#f5f5f5';
  }
  if (!filled.surfaceBorderColor) {
    filled.surfaceBorderColor = isDark ? '#2e2e2e' : '#e5e5e5';
  }
  if (!filled.mutedTextColor) {
    filled.mutedTextColor = isDark ? '#a3a3a3' : '#737373';
  }
  if (!filled.accentDarkColor) {
    // Legacy themes used primaryColor as the CTA fill — preserve that.
    filled.accentDarkColor = filled.primaryColor;
  }

  return filled;
}

/**
 * Migrates legacy theme configurations:
 *  - 'hero' galleryLayout → decoupled headerStyle + galleryLayout
 *  - missing 8-token CI palette fields → derived from legacy 4-color set
 *
 * This ensures backward compatibility with existing events.
 */
export function migrateThemeConfig(theme: ThemeConfig): ThemeConfig {
  if (!theme) return theme;

  let migrated = theme;

  // Check if this theme uses the legacy 'hero' layout
  if ((migrated.galleryLayout as string) === 'hero') {
    migrated = {
      ...migrated,
      headerStyle: 'hero' as HeaderStyleType,
      galleryLayout: 'grid' as GalleryLayoutType,
      heroDividerStyle: (migrated.heroDividerStyle || 'wave') as HeroDividerStyle,
    };
  }

  // If headerStyle is not set but galleryLayout is valid, default to 'standard'
  if (!migrated.headerStyle && migrated.galleryLayout) {
    migrated = {
      ...migrated,
      headerStyle: 'standard' as HeaderStyleType,
    };
  }

  // Fill any missing 8-token palette fields so the renderer never has to
  // fall back to hard-coded defaults that diverge from the original look.
  return fillMissingPaletteTokens(migrated);
}

/**
 * Parses and migrates a color_theme JSON string from the database.
 * Handles both JSON strings and legacy preset names.
 */
export function parseAndMigrateTheme(colorTheme: string | null | undefined): ThemeConfig | null {
  if (!colorTheme) return null;

  try {
    // Check if it's a JSON string
    if (colorTheme.startsWith('{')) {
      const parsed = JSON.parse(colorTheme);
      return migrateThemeConfig(parsed);
    }

    // Legacy preset name - return null to let the caller handle preset lookup
    return null;
  } catch {
    // Invalid JSON
    return null;
  }
}

/**
 * Checks if a theme configuration needs migration from legacy hero layout.
 */
export function needsMigration(theme: ThemeConfig): boolean {
  return (theme.galleryLayout as string) === 'hero';
}
