import type { ThemeConfig } from '../../../types/theme.types';
import { contrastRatio, getReadableForeground } from '../../../utils/contrast';
import { DEFAULT_STATUS_COLORS, STATUS_KEYS, type StatusColors, type StatusKey } from '../../../utils/statusColors';

/**
 * Readability checks for Branding › Colours, shown under the picker they
 * concern. They inform and never block: a studio may know its palette
 * better than a ratio does.
 */

export type ColorWarning =
  | { code: 'textOnBackground' | 'textOnSurface' | 'textOnElevated' | 'mutedOnSurface' | 'buttonLabel' | 'accentOnBackground'; ratio: number; needed: number }
  | { code: 'borderInvisible'; ratio: number; needed: number }
  | { code: 'statusTooLight'; ratio: number; needed: number }
  | { code: 'statusLikeAccent' }
  | { code: 'statusLikeStatus'; other: StatusKey };

/** Picker key → its warnings. Theme keys are ThemeConfig fields; status keys are `status.<key>`. */
export type ColorWarnings = Partial<Record<string, ColorWarning[]>>;

const HEX6 = /^#[0-9a-f]{6}$/i;
const round = (n: number) => Math.round(n * 10) / 10;

/** Perceived distance between two colours (weighted RGB, 0–~765). */
function distance(a: string, b: string): number {
  const p = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const [r1, g1, b1] = p(a);
  const [r2, g2, b2] = p(b);
  const rMean = (r1 + r2) / 2;
  return Math.sqrt((2 + rMean / 256) * (r1 - r2) ** 2 + 4 * (g1 - g2) ** 2 + (2 + (255 - rMean) / 256) * (b1 - b2) ** 2);
}

const SIMILAR = 100;

export function colorWarnings(theme: ThemeConfig, status: StatusColors = {}): ColorWarnings {
  const out: ColorWarnings = {};
  const add = (key: string, warning: ColorWarning) => { (out[key] ||= []).push(warning); };
  const ok = (...values: Array<string | undefined>) => values.every((v) => !!v && HEX6.test(v));
  const check = (key: string, code: Extract<ColorWarning, { ratio: number }>['code'], a?: string, b?: string, needed = 4.5) => {
    if (!ok(a, b)) return;
    const ratio = contrastRatio(a as string, b as string);
    if (ratio < needed) add(key, { code, ratio: round(ratio), needed } as ColorWarning);
  };

  const { textColor, backgroundColor, surfaceColor, elevatedColor, mutedTextColor, surfaceBorderColor, accentColor, accentDarkColor } = theme;
  check('textColor', 'textOnBackground', textColor, backgroundColor);
  check('textColor', 'textOnSurface', textColor, surfaceColor);
  check('elevatedColor', 'textOnElevated', textColor, elevatedColor);
  check('mutedTextColor', 'mutedOnSurface', mutedTextColor, surfaceColor);
  check('surfaceBorderColor', 'borderInvisible', surfaceBorderColor, surfaceColor, 1.1);
  check('accentColor', 'accentOnBackground', accentColor, backgroundColor, 3);
  if (ok(accentDarkColor)) check('accentDarkColor', 'buttonLabel', getReadableForeground(accentDarkColor), accentDarkColor);

  const hues = STATUS_KEYS.map((key) => [key, status[key] || DEFAULT_STATUS_COLORS[key]] as const);
  for (const [key, hue] of hues) {
    if (!ok(hue)) continue;
    // Badge text is the hue darkened, but buttons and dots put white on the
    // hue itself: 3:1 is the floor for both (WCAG non-text and bold text).
    check(`status.${key}`, 'statusTooLight', hue, '#ffffff', 3);
    if (ok(accentDarkColor) && distance(hue, accentDarkColor as string) < SIMILAR) {
      add(`status.${key}`, { code: 'statusLikeAccent' });
    }
  }
  for (let i = 0; i < hues.length; i++) {
    for (let j = i + 1; j < hues.length; j++) {
      const [a, hueA] = hues[i];
      const [b, hueB] = hues[j];
      if (ok(hueA, hueB) && distance(hueA, hueB) < SIMILAR) add(`status.${b}`, { code: 'statusLikeStatus', other: a });
    }
  }
  return out;
}
