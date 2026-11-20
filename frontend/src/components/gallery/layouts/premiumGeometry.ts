import type { GalleryLayoutSettings } from '../../../types/theme.types';

/**
 * Gallery Premium's columns and gap (issue 2425). The admin sets columns for
 * a phone, a tablet and a desktop and the gap in pixels; the theme JSON is
 * stored as sent, so every value is clamped here and an unset one keeps the
 * original 1, 2 and 3 columns and 16 px.
 */
export const PREMIUM_COLUMN_LIMITS = {
  mobile: { min: 1, max: 3, fallback: 1 },
  tablet: { min: 1, max: 4, fallback: 2 },
  desktop: { min: 1, max: 6, fallback: 3 },
} as const;
export const PREMIUM_GAP_LIMITS = { min: 0, max: 32, fallback: 16 } as const;

export type PremiumColumns = { mobile: number; tablet: number; desktop: number };

const clamp = (value: unknown, limits: { min: number; max: number; fallback: number }) => {
  const n = value === null || value === undefined || value === '' ? NaN : Math.round(Number(value));
  return Number.isFinite(n) ? Math.min(limits.max, Math.max(limits.min, n)) : limits.fallback;
};

/** One device's column count from any input, an admin's field or stored JSON. */
export const clampPremiumColumns = (device: keyof PremiumColumns, value: unknown) =>
  clamp(value, PREMIUM_COLUMN_LIMITS[device]);
export const clampPremiumGap = (value: unknown) => clamp(value, PREMIUM_GAP_LIMITS);

export function premiumColumns(settings?: GalleryLayoutSettings): PremiumColumns {
  const columns = settings?.premiumColumns;
  return {
    mobile: clampPremiumColumns('mobile', columns?.mobile),
    tablet: clampPremiumColumns('tablet', columns?.tablet),
    desktop: clampPremiumColumns('desktop', columns?.desktop),
  };
}

export function premiumGap(settings?: GalleryLayoutSettings): number {
  return clampPremiumGap(settings?.premiumGap);
}

/** The column count for the album's width: below 640 px a phone, below 1024 px a tablet. */
export const columnsForWidth = (columns: PremiumColumns) => (containerWidth: number) => {
  if (containerWidth < 640) return columns.mobile;
  if (containerWidth < 1024) return columns.tablet;
  return columns.desktop;
};

/** Highlights (issue 2549) are this much taller than their own shape. */
export const PREMIUM_HIGHLIGHT_STRETCH = 1.5;
/** ...but never narrower than 1:2, unless the photo itself is. */
const PREMIUM_HIGHLIGHT_MIN_RATIO = 0.5;

/**
 * The shape the album lays a photo out in. The masonry columns are all one
 * width, so a highlight's larger tile is a taller one, its image cropped
 * around the focal point. Without highlights, the photo's own shape.
 */
export function premiumTileSize(photo: { width?: number | null; height?: number | null; is_highlight?: boolean }) {
  const width = photo.width || 1200;
  const height = photo.height || 800;
  if (!photo.is_highlight) return { width, height };
  // The cap never makes a highlight shorter than the photo's own tile.
  const ratio = Math.min(width / height, Math.max(width / height / PREMIUM_HIGHLIGHT_STRETCH, PREMIUM_HIGHLIGHT_MIN_RATIO));
  return { width, height: Math.round(width / ratio) };
}
