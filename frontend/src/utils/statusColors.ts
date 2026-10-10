/**
 * Status colours (Branding › Colours). One hue per meaning; tokens.css
 * derives the text, tint and border for light and dark from it, and both the
 * admin (Badge, Notice) and the portal (.status-chip) read them.
 * Mirrors backend/src/utils/statusColors.js.
 */

export const STATUS_KEYS = ['success', 'warning', 'danger', 'info', 'storno'] as const;
export type StatusKey = typeof STATUS_KEYS[number];
export type StatusColors = Partial<Record<StatusKey, string>>;

/** The built-in hues, identical to the --status-* defaults in tokens.css. */
export const DEFAULT_STATUS_COLORS: Record<StatusKey, string> = {
  success: '#16a34a',
  warning: '#d97706',
  danger: '#dc2626',
  info: '#2563eb',
  storno: '#9333ea',
};

const HEX6 = /^#[0-9a-f]{6}$/i;

/** Known keys with a #rrggbb value; anything else is dropped. */
export function normalizeStatusColors(value: unknown): StatusColors {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: StatusColors = {};
  for (const key of STATUS_KEYS) {
    const color = (value as Record<string, unknown>)[key];
    if (typeof color === 'string' && HEX6.test(color.trim())) out[key] = color.trim().toLowerCase();
  }
  return out;
}

/**
 * Writes the picked hues as inline --status-* on <html> and removes the
 * ones not picked, so tokens.css's default shows through for those.
 */
export function applyStatusColors(colors: StatusColors, root: HTMLElement = document.documentElement): void {
  for (const key of STATUS_KEYS) {
    const value = colors[key];
    if (value) root.style.setProperty(`--status-${key}`, value);
    else root.style.removeProperty(`--status-${key}`);
  }
}
