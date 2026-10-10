/**
 * Pick a readable foreground colour (white or black) for a given background.
 *
 * Used by ThemeContext.applyTheme to derive `--color-accent-fg` so that
 * accent-coloured CTAs (Download button on the gallery header) stay
 * readable regardless of which accent the admin has picked. Without this,
 * a pale accent (e.g. light yellow) would render the hardcoded white text
 * unreadable — see PR #401 review notes and PR #400's expanded palette.
 *
 * Approach: compute the WCAG relative luminance of the background, then
 * return whichever of #ffffff / #000000 yields the higher contrast ratio.
 * For colours far from grey the choice is unambiguous; for mid-greys it
 * picks the one that crosses the 4.5:1 threshold (or the closest if
 * neither does — at that point the underlying accent itself fails WCAG
 * and the admin needs to pick a different colour).
 */

/**
 * WCAG 2.x relative luminance for an sRGB colour.
 * https://www.w3.org/TR/WCAG21/#dfn-relative-luminance
 */
export function relativeLuminance(hex: string): number {
  const parsed = parseHex(hex);
  if (!parsed) return 0;
  const { r, g, b } = parsed;
  const lin = (c: number): number =>
    c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  return 0.2126 * lin(r / 255) + 0.7152 * lin(g / 255) + 0.0722 * lin(b / 255);
}

/**
 * WCAG 2.x contrast ratio between two colours, from 1 (identical) to 21
 * (black on white). https://www.w3.org/TR/WCAG21/#dfn-contrast-ratio
 */
export function contrastRatio(hexA: string, hexB: string): number {
  const a = relativeLuminance(hexA);
  const b = relativeLuminance(hexB);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/**
 * Return '#ffffff' or '#000000' for text/icons painted on top of the
 * supplied background. Uses a relative-luminance threshold of 0.5:
 *   L >= 0.5  → background is "light" → return '#000000'
 *   L <  0.5  → background is "dark"  → return '#ffffff'
 *
 * Why a threshold rather than "highest contrast ratio":
 * the threshold matches conventional design-system behaviour and
 * preserves how saturated mid-tone accents (e.g. PicPeak's default
 * green #5C8762, L≈0.20) have always rendered — white text. The
 * "best contrast" approach would technically pick black on some
 * dark-but-saturated colours where black gives a marginally higher
 * ratio (5:1 vs 4.2:1), but that flips the visual identity of every
 * deployment that hasn't customised its accent. The threshold change
 * only kicks in for genuinely pale accents (yellow, pastel blue, etc.)
 * where white-on-pale was the unreadable case PR #401's review flagged.
 *
 * Falls back to '#ffffff' for unparseable input — the legacy hardcoded
 * value, so consumers see no regression on bad data.
 */
export function getReadableForeground(hex: string | undefined | null): '#ffffff' | '#000000' {
  if (!hex) return '#ffffff';
  if (!parseHex(hex)) return '#ffffff';
  return relativeLuminance(hex) >= 0.5 ? '#000000' : '#ffffff';
}

/**
 * The colour to use for accent-coloured TEXT (links, inline actions) on the
 * given background: the accent itself when it already reads (>= `target`,
 * 4.5:1 by default), otherwise the accent mixed toward black or white —
 * whichever of the two contrasts more with the background (the crossover is
 * at a luminance of about 0.18, not 0.5) — in 5 % steps until it does.
 * A pastel brand accent then keeps its hue as a link instead of fading into a
 * white card. Unparseable input comes back unchanged.
 */
/**
 * Whether a background is dark in the sense that matters for text on it:
 * white contrasts more than black. The crossover sits at a luminance of
 * about 0.18, so a mid grey like #8a9a8a counts as light.
 */
export function isDarkBackground(hex: string): boolean {
  if (!parseHex(hex)) return false;
  return contrastRatio('#ffffff', hex) > contrastRatio('#000000', hex);
}

export function readableAccentText(accent: string, background: string, target = 4.5): string {
  const fg = parseHex(accent);
  const bg = parseHex(background);
  if (!fg || !bg) return accent;
  if (contrastRatio(accent, background) >= target) return accent;
  const toward = contrastRatio('#000000', background) >= contrastRatio('#ffffff', background) ? 0 : 255;
  for (let step = 1; step <= 20; step += 1) {
    const w = step / 20;
    const mix = (c: number) => Math.round(c + (toward - c) * w);
    const hex = `#${[mix(fg.r), mix(fg.g), mix(fg.b)].map((c) => c.toString(16).padStart(2, '0')).join('')}`;
    if (contrastRatio(hex, background) >= target) return hex;
  }
  return toward === 0 ? '#000000' : '#ffffff';
}

/**
 * Accept #RGB, #RRGGBB, or those without leading '#'. Returns null on bad
 * input so callers can fall back gracefully.
 */
function parseHex(hex: string): { r: number; g: number; b: number } | null {
  const cleaned = hex.trim().replace(/^#/, '');
  if (cleaned.length === 3 && /^[0-9a-fA-F]{3}$/.test(cleaned)) {
    return {
      r: parseInt(cleaned[0] + cleaned[0], 16),
      g: parseInt(cleaned[1] + cleaned[1], 16),
      b: parseInt(cleaned[2] + cleaned[2], 16),
    };
  }
  if (cleaned.length === 6 && /^[0-9a-fA-F]{6}$/.test(cleaned)) {
    return {
      r: parseInt(cleaned.slice(0, 2), 16),
      g: parseInt(cleaned.slice(2, 4), 16),
      b: parseInt(cleaned.slice(4, 6), 16),
    };
  }
  return null;
}
