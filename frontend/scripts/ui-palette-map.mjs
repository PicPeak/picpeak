/**
 * Raw Tailwind colour classes → the colour tokens (src/styles/tokens.css).
 * Shared by the `ui-tokens/no-raw-palette` lint rule (eslint.config.js) and
 * scripts/codemod-ui-tokens.mjs, so the rule and the codemod never disagree.
 * frontend/STYLING.md › Colour classes documents the result.
 *
 * A hue that carries a meaning maps to its status token, the old fixed green
 * `primary-*` scale to the studio's accent:
 *
 *   bg-red-50 / bg-red-100 …  dark:bg-red-900/20   ->  bg-danger-soft
 *   text-red-600 … text-red-900  dark:text-red-300  ->  text-danger-text
 *   border-red-200            dark:border-red-800    ->  border-danger-line
 *   bg-red-600  hover:bg-red-700                     ->  bg-danger  hover:opacity-90
 *   bg-primary-600 · text-primary-600 · ring-primary-500  ->  bg-accent-strong · text-accent · ring-accent
 *
 * The token carries its own dark value, so the `dark:` partner of a mapped
 * class is dropped. Hues without a fixed meaning (purple, indigo, teal, pink,
 * cyan, lime, orange, yellow, sand …) have no automatic mapping: the rule
 * reports them and a person picks a status, a data colour (chart-1 … 8) or
 * a neutral.
 */

export const STATUS_HUES = {
  green: 'success', emerald: 'success',
  red: 'danger', rose: 'danger',
  amber: 'warning',
  blue: 'info', sky: 'info',
};

export const ALL_HUES = [
  'red', 'orange', 'amber', 'yellow', 'lime', 'green', 'emerald', 'teal', 'cyan', 'sky', 'blue',
  'indigo', 'violet', 'purple', 'fuchsia', 'pink', 'rose', 'primary', 'sand',
];

const UTILS = 'bg|text|border(?:-[trblxy])?|ring-offset|ring|fill|stroke|divide|outline|placeholder|accent|decoration|caret|from|via|to';
// variants (hover:, focus-visible:, dark:, group-hover:, prose-a: …) · utility · hue · shade · /opacity
export const PALETTE_RE = new RegExp(
  `^((?:[a-z0-9-]+:)*)(${UTILS})-(${ALL_HUES.join('|')})-(\\d{2,3})(?:\\/(\\d{1,3}))?$`,
);

const line = (u) => /^(border|divide|outline)/.test(u);

/** The token class for one light-mode class, or null when it has none. */
function mapStatus(variants, util, status, shade, alpha) {
  if (util === 'bg') {
    const soft = alpha != null ? alpha <= 30 : shade <= 200;
    if (/(^|:)hover:$/.test(variants) && !soft) return `${variants.replace(/hover:$/, '')}hover:opacity-90`;
    return `${variants}bg-${soft ? `${status}-soft` : status}`;
  }
  if (util === 'text') return `${variants}text-${shade >= 600 ? `${status}-text` : status}`;
  if (util === 'placeholder') return `${variants}placeholder-${status}-text`;
  if (line(util)) return `${variants}${util}-${shade <= 300 ? `${status}-line` : status}`;
  return `${variants}${util}-${status}`;
}

function mapAccent(variants, util, shade, alpha) {
  if (util === 'bg') {
    const soft = alpha != null ? alpha <= 30 : shade <= 200;
    if (/(^|:)hover:$/.test(variants) && !soft) return `${variants.replace(/hover:$/, '')}hover:opacity-90`;
    return `${variants}bg-${soft ? 'accent-soft' : 'accent-strong'}`;
  }
  // Dark accent text sits on an accent tint; a hover shade is still the link.
  if (util === 'text') return `${variants}text-${shade >= 800 && !variants ? 'on-accent-soft' : 'accent'}`;
  if (line(util)) return `${variants}${util}-${shade <= 300 ? 'accent-soft' : 'accent'}`;
  if (util === 'placeholder') return null;
  return `${variants}${util}-accent`;
}

/** A data colour (chart-N) for a hue used only to tell things apart. */
function mapChart(variants, util, n, shade, alpha) {
  if (util === 'bg') {
    const soft = alpha != null ? alpha <= 30 : shade <= 200;
    return `${variants}bg-${soft ? 'inset' : `chart-${n}`}`;
  }
  if (util === 'placeholder') return null;
  return `${variants}${util}-chart-${n}`;
}

/**
 * Rewrite the palette classes in one class list. Returns the new string and
 * the classes it could not map (for the lint message). `dark:` classes of a
 * hue are dropped when a light class of the same hue group and utility was
 * mapped in the same list; a lone one is reported.
 *
 * `hues` decides the hues without a fixed meaning, for a one-off migration
 * of a file where a person has looked at what they mean: a status name,
 * 'accent', 'rating' or 'chart-<n>'.
 */
export function rewritePalette(str, { hues = {} } = {}) {
  const toks = str.split(/(\s+)/);
  const parsed = toks.map((t) => {
    const m = t.match(PALETTE_RE);
    if (!m) return null;
    const [, variants, util, hue, shade, alpha] = m;
    const group = hues[hue] || (hue === 'primary' ? 'accent' : STATUS_HUES[hue] || null);
    return { variants, util, hue, shade: Number(shade), alpha: alpha == null ? null : Number(alpha), group, dark: /(^|:)dark:/.test(variants) };
  });

  // Blue text with a hover colour of its own is a link: the accent, not info.
  const linkHues = new Set(parsed.filter((p) => p && !p.dark && p.util === 'text' && /hover:$/.test(p.variants)
    && (p.hue === 'blue' || p.hue === 'sky')).map((p) => p.hue));
  for (const p of parsed) if (p && p.util === 'text' && linkHues.has(p.hue)) p.group = 'accent';

  const mappedKeys = new Set();
  const unmapped = [];
  const out = toks.slice();
  parsed.forEach((p, i) => {
    if (!p || p.dark) return;
    // A focus ring or focus border is focus feedback in any hue: the accent.
    if (/(^|:)focus(-visible|-within)?:$/.test(p.variants) && /^(ring|border|outline)/.test(p.util)) {
      out[i] = `${p.variants}${p.util}-accent`;
      mappedKeys.add(`focus|${p.util}`);
      return;
    }
    if (!p.group) { unmapped.push(toks[i]); return; }
    const next = p.group === 'accent'
      ? mapAccent(p.variants, p.util, p.shade, p.alpha)
      : p.group === 'rating'
        ? `${p.variants}${p.util}-rating`
        : p.group.startsWith('chart-')
          ? mapChart(p.variants, p.util, p.group.slice(6), p.shade, p.alpha)
          : mapStatus(p.variants, p.util, p.group, p.shade, p.alpha);
    if (!next) { unmapped.push(toks[i]); return; }
    out[i] = next;
    mappedKeys.add(`${p.group}|${p.util.replace(/-[trblxy]$/, '')}`);
  });
  parsed.forEach((p, i) => {
    if (!p || !p.dark) return;
    const focus = /focus(-visible|-within)?:$/.test(p.variants) && mappedKeys.has(`focus|${p.util}`);
    if (focus || (p.group && mappedKeys.has(`${p.group}|${p.util.replace(/-[trblxy]$/, '')}`))) {
      out[i] = '';
      if (i > 0 && /^\s+$/.test(out[i - 1])) out[i - 1] = '';
      return;
    }
    unmapped.push(toks[i]);
  });

  // A mapped hover/focus class equal to its base class does nothing
  // (hover:text-red-700 next to text-red-600 both become text-danger-text),
  // and the same class twice collapses to one.
  const present = new Set(out.filter((t) => t && !/^\s+$/.test(t)));
  const seen = new Set();
  for (let i = 0; i < out.length; i++) {
    if (!parsed[i] || !out[i]) continue;
    const base = out[i].replace(/^(?:(?:hover|focus|group-hover|focus-visible):)+/, '');
    // A soft hover tint on a box of the same tint still needs feedback.
    if (base !== out[i] && present.has(base) && /hover:bg-[a-z-]+-soft$/.test(out[i])) {
      out[i] = out[i].replace(/bg-[a-z-]+-soft$/, 'brightness-95');
      seen.add(out[i]);
      continue;
    }
    if (seen.has(out[i]) || (base !== out[i] && present.has(base))) {
      out[i] = '';
      if (i > 0 && /^\s+$/.test(out[i - 1])) out[i - 1] = '';
      continue;
    }
    seen.add(out[i]);
  }
  // Accent text on an accent tint disappears on dark themes (STYLING.md):
  // content on bg-accent-soft takes text-on-accent-soft.
  if (out.includes('bg-accent-soft')) {
    for (let i = 0; i < out.length; i++) if (parsed[i] && out[i] === 'text-accent') out[i] = 'text-on-accent-soft';
  }
  const lead = str.match(/^\s*/)[0];
  const trail = str.length > lead.length ? str.match(/\s*$/)[0] : '';
  const next = lead + out.join('').trim() + trail;
  return { next, changed: next !== str, unmapped };
}
