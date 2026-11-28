import type { CSSProperties } from 'react';
import type { GalleryLayoutSettings } from '../../../types/theme.types';

/**
 * Gallery Folio's design options (issue 2617), read from the theme's
 * gallerySettings. The theme JSON is stored as sent, so every value is
 * checked here and anything unknown falls back to the default.
 */
export const FOLIO_COVERS = ['full', 'split'] as const;
export const FOLIO_PALETTES = ['paper', 'white', 'charcoal'] as const;
export const FOLIO_TYPES = ['classic', 'modern'] as const;
export const FOLIO_SPACINGS = ['compact', 'regular', 'airy'] as const;

export type FolioCover = typeof FOLIO_COVERS[number];
export type FolioPalette = typeof FOLIO_PALETTES[number];
export type FolioType = typeof FOLIO_TYPES[number];
export type FolioSpacing = typeof FOLIO_SPACINGS[number];

export const FOLIO_COLUMN_LIMITS = {
  mobile: { min: 1, max: 2, fallback: 2 },
  desktop: { min: 2, max: 4, fallback: 3 },
} as const;
export type FolioColumns = { mobile: number; desktop: number };

export const FOLIO_STUDIO_LABEL_MAX = 60;

/**
 * From here up the nav row holds every action; below, the secondary ones
 * move into its menu. The stylesheet switches at the same width
 * (GalleryFolioLayout.css; the stylesheet test holds the two together).
 */
export const FOLIO_WIDE_NAV_QUERY = '(min-width: 640px)';

/** Gap between photos in px. */
export const FOLIO_GAPS: Record<FolioSpacing, number> = { compact: 4, regular: 12, airy: 28 };

/**
 * The three palettes, as the gallery's own theme tokens. Inside the layout
 * they replace the operator's colours, the accent included, so the feature
 * toolbox, the empty messages and the buttons in it follow the palette too.
 * Text and muted text keep at least 4.5:1 on the background and the surface,
 * and so does a filled control against what is written on it
 * (folioSettings test).
 */
export const FOLIO_PALETTE_COLORS: Record<FolioPalette, {
  background: string;
  surface: string;
  elevated: string;
  border: string;
  text: string;
  muted: string;
}> = {
  paper: {
    background: '#f4f1eb', surface: '#faf8f4', elevated: '#e9e4da', border: '#dcd4c6', text: '#24211d', muted: '#655e54',
  },
  white: {
    background: '#ffffff', surface: '#ffffff', elevated: '#f2f2f0', border: '#e4e4e1', text: '#1b1b1a', muted: '#656563',
  },
  charcoal: {
    background: '#1c1c1b', surface: '#252524', elevated: '#30302e', border: '#3d3d3a', text: '#eeece7', muted: '#aba79f',
  },
};

export interface FolioSettings {
  cover: FolioCover;
  palette: FolioPalette;
  type: FolioType;
  spacing: FolioSpacing;
  columns: FolioColumns;
  studioLabel: string;
}

const oneOf = <T extends string>(options: readonly T[], value: unknown, fallback: T): T =>
  (options as readonly unknown[]).includes(value) ? value as T : fallback;

/** One device's column count from any input, an admin's field or stored JSON. */
export function clampFolioColumns(device: keyof FolioColumns, value: unknown): number {
  const limits = FOLIO_COLUMN_LIMITS[device];
  const n = value === null || value === undefined || value === '' ? NaN : Math.round(Number(value));
  return Number.isFinite(n) ? Math.min(limits.max, Math.max(limits.min, n)) : limits.fallback;
}

export function folioSettings(settings?: GalleryLayoutSettings): FolioSettings {
  return {
    cover: oneOf(FOLIO_COVERS, settings?.folioCover, 'full'),
    palette: oneOf(FOLIO_PALETTES, settings?.folioPalette, 'paper'),
    type: oneOf(FOLIO_TYPES, settings?.folioType, 'classic'),
    spacing: oneOf(FOLIO_SPACINGS, settings?.folioSpacing, 'regular'),
    columns: {
      mobile: clampFolioColumns('mobile', settings?.folioColumns?.mobile),
      desktop: clampFolioColumns('desktop', settings?.folioColumns?.desktop),
    },
    studioLabel: typeof settings?.folioStudioLabel === 'string'
      ? settings.folioStudioLabel.trim().slice(0, FOLIO_STUDIO_LABEL_MAX)
      : '',
  };
}

/**
 * The column count for the album's width: a phone below 640 px, a tablet one
 * column short of the desktop below 1024 px.
 */
export const folioColumnsForWidth = ({ mobile, desktop }: FolioColumns) => (containerWidth: number): number => {
  if (containerWidth < 640) return mobile;
  if (containerWidth < 1024) return Math.max(mobile, desktop - 1);
  return desktop;
};

/** The palette as the theme tokens the gallery's components read. */
export function folioPaletteStyle(palette: FolioPalette): CSSProperties {
  const colors = FOLIO_PALETTE_COLORS[palette];
  return {
    '--color-background': colors.background,
    '--color-surface': colors.surface,
    '--color-elevated': colors.elevated,
    '--color-surface-border': colors.border,
    '--color-text': colors.text,
    '--color-muted-text': colors.muted,
    // Links and active chips in the palette's ink: the operator's accent is
    // tuned for their own page and can vanish on charcoal.
    '--accent-text': colors.text,
    '--color-accent-text': colors.text,
    // Filled controls in the palette's ink as well (the primary button, the
    // nav's cart, a checked box): the operator's accent is tuned for their
    // own page, and a dark one would vanish on charcoal. Every token is
    // written out, because the --ui-* ones resolve their var() where they are
    // declared, on :root, and would keep the operator's value in here.
    '--color-accent': colors.text,
    '--color-accent-fg': colors.background,
    '--color-accent-dark': colors.text,
    '--color-accent-dark-fg': colors.background,
    '--ui-accent': colors.text,
    '--ui-accent-strong': colors.text,
    '--ui-accent-fg': colors.background,
    '--ui-accent-soft': colors.elevated,
    '--ui-accent-line': colors.border,
    '--ui-accent-on-soft': colors.text,
    // The shared primitives inside (the nav's menu) read the UI tokens.
    '--ui-panel': colors.surface,
    '--ui-hover': colors.elevated,
    '--ui-line': colors.border,
    '--ui-text-body': colors.text,
    '--ui-text-heading': colors.text,
    backgroundColor: colors.background,
    color: colors.text,
  } as CSSProperties;
}
