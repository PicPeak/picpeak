/**
 * The PDF theme's layout helpers for the theme card (#1445): the built-in
 * presets, and the readability warnings for the settings being edited —
 * the same rules the backend applies to the saved theme
 * (services/pdf/theme.js themeWarnings).
 */
import type {
  PdfColorKey, PdfMargins, PdfThemeSettings, PdfThemeWarning, ResolvedPdfTheme,
} from '../../services/pdfThemes.service';

/** The bounds the backend enforces (services/pdf/theme.js MARGIN_BOUNDS), in mm. */
export const MARGIN_BOUNDS: Record<keyof PdfMargins, [number, number]> = { left: [20, 30], right: [10, 25], bottom: [15, 30] };

export type PdfThemePreset = 'classic' | 'modern' | 'compact' | 'largePrint';

/**
 * Starting points, applied into the form (not stored as a reference): every
 * key they set can be changed afterwards.
 */
export const PDF_THEME_PRESETS: Record<PdfThemePreset, PdfThemeSettings> = {
  classic: {
    colors: { text: '#000000', muted: '#666666', accent: '#000000' },
    titleSize: 20, bodySize: 10,
    layout: { margins: { left: 25, right: 20, bottom: 20 }, addressWindow: true },
    logo: { position: 'right', stack: 'above' },
  },
  modern: {
    colors: { text: '#1a1a1a', muted: '#555555', accent: '#1f4e79' },
    titleSize: 24, bodySize: 10, lineHeight: 1.4, pageNumbers: 'bottom-center',
    layout: { margins: { left: 25, right: 20, bottom: 20 }, addressWindow: true },
    logo: { position: 'left', stack: 'above' },
  },
  compact: {
    titleSize: 16, bodySize: 9.5, lineHeight: 1.3,
    layout: { margins: { left: 20, right: 15, bottom: 15 } },
  },
  largePrint: {
    colors: { text: '#000000', muted: '#444444' },
    titleSize: 26, bodySize: 12, lineHeight: 1.5,
    layout: { margins: { left: 25, right: 20, bottom: 20 } },
  },
};

/** The draft laid over what the scope inherits. */
export function effectiveTheme(resolved: ResolvedPdfTheme, draft: PdfThemeSettings) {
  return {
    colors: { ...resolved.colors, ...(draft.colors || {}) } as Record<PdfColorKey, string>,
    bodySize: draft.bodySize ?? resolved.bodySize ?? 10,
    lineHeight: draft.lineHeight ?? resolved.lineHeight ?? null,
    margins: { ...(resolved.layout?.margins || {}), ...(draft.layout?.margins || {}) },
  };
}

const MM_PER_PT = 25.4 / 72;
const PAGE_WIDTH_PT = 595.28;
const DEFAULT_MARGIN_PT = 40;
const AVERAGE_GLYPH_EM = 0.55;
const MAX_MEASURE = 95;

function luminance(hex: string): number {
  const channel = (i: number) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

export const contrastOnWhite = (hex: string) => 1.05 / (luminance(hex) + 0.05);

export function themeWarnings(theme: ReturnType<typeof effectiveTheme>): PdfThemeWarning[] {
  const warnings: PdfThemeWarning[] = [];
  const round = (n: number) => Math.round(n * 10) / 10;
  for (const key of ['text', 'muted'] as const) {
    if (!/^#[0-9a-f]{6}$/i.test(theme.colors[key] || '')) continue;
    const ratio = contrastOnWhite(theme.colors[key]);
    if (ratio < 4.5) warnings.push({ code: 'CONTRAST_LOW', key, value: round(ratio), limit: 4.5 });
  }
  if (/^#[0-9a-f]{6}$/i.test(theme.colors.accent || '')) {
    const accent = contrastOnWhite(theme.colors.accent);
    if (accent < 3) warnings.push({ code: 'CONTRAST_LOW', key: 'accent', value: round(accent), limit: 3 });
  }
  if (theme.bodySize < 9.5) warnings.push({ code: 'BODY_SIZE_SMALL', value: theme.bodySize, limit: 9.5 });
  if (theme.lineHeight != null && theme.lineHeight < 1.3) {
    warnings.push({ code: 'LINE_HEIGHT_TIGHT', value: theme.lineHeight, limit: 1.3 });
  }
  const left = theme.margins.left != null ? theme.margins.left / MM_PER_PT : DEFAULT_MARGIN_PT;
  const right = theme.margins.right != null ? theme.margins.right / MM_PER_PT : DEFAULT_MARGIN_PT;
  const chars = (PAGE_WIDTH_PT - left - right) / (AVERAGE_GLYPH_EM * theme.bodySize);
  if (chars > MAX_MEASURE) warnings.push({ code: 'LINE_TOO_LONG', value: Math.round(chars), limit: MAX_MEASURE });
  return warnings;
}
