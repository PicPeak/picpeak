import { GALLERY_THEME_PRESETS, type ThemeConfig } from '../types/theme.types';

/**
 * The theme a gallery applies: the event's `color_theme` JSON, else the
 * preset it names, else the global `theme_config`. Null when none of them
 * yields one. A `color_theme` that fails to parse falls back to the global
 * theme; `onParseError` lets a caller log it.
 *
 * The preset and global objects are returned as they are, not copied.
 */
export function resolveEventTheme(
  colorTheme: string | null | undefined,
  globalTheme: ThemeConfig | null | undefined,
  onParseError?: (error: unknown) => void,
): ThemeConfig | null {
  const fallback = globalTheme || null;
  if (!colorTheme) return fallback;
  try {
    if (colorTheme.startsWith('{')) return JSON.parse(colorTheme) as ThemeConfig;
    // A legacy theme name: a preset, or an unknown name that falls back.
    const preset = GALLERY_THEME_PRESETS[colorTheme];
    return preset ? preset.config : fallback;
  } catch (error) {
    onParseError?.(error);
    return fallback;
  }
}
