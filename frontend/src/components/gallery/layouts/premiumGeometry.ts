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
