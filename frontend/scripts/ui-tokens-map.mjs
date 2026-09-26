/**
 * The light/dark class pairs that have a UI token, and the token each maps to.
 * Shared by scripts/codemod-ui-tokens.mjs (rewrites) and eslint.config.js
 * (refuses new ones). The table itself is documented in frontend/STYLING.md.
 *
 * Mapping is by the LIGHT shade; the dark partner is dropped and the token's
 * own dark value applies. The *_BY_PAIR tables override that for pairs whose
 * dark partner says which token was meant (bg-white + dark:bg-neutral-900 is
 * the header/sidebar shell, not a panel).
 */
const BG = {
  'white': 'panel', 'neutral-50': 'subtle', 'neutral-100': 'inset',
  'neutral-200': 'fill', 'neutral-300': 'fill-strong',
};
const BG_BY_PAIR = {
  'white|neutral-900': 'shell', 'neutral-50|neutral-900': 'shell',
  'white|neutral-950': 'canvas', 'neutral-50|neutral-950': 'canvas',
  'neutral-50|neutral-700': 'inset', 'white|neutral-700': 'inset',
  'neutral-100|neutral-800': 'subtle',
};
const HOVER_BG = {
  'neutral-50': 'hover-soft', 'neutral-100': 'hover', 'neutral-200': 'hover', 'white': 'panel',
};
const HOVER_BG_BY_PAIR = { 'neutral-50|neutral-700': 'hover', 'neutral-100|neutral-800': 'hover-soft' };
const TEXT = {
  'neutral-900': 'heading', 'neutral-800': 'heading', 'neutral-700': 'body',
  'neutral-600': 'soft', 'neutral-500': 'muted', 'neutral-400': 'faint',
};
// 600/300 and 600/200 read as body text in dark mode; body keeps that.
const TEXT_BY_PAIR = { 'neutral-800|neutral-200': 'body', 'neutral-600|neutral-300': 'body', 'neutral-600|neutral-200': 'body' };
const LINE = { 'neutral-100': 'line-faint', 'neutral-200': 'line', 'neutral-300': 'line-strong' };
const LINE_BY_PAIR = { 'neutral-100|neutral-700': 'line', 'neutral-200|neutral-800': 'line-faint' };

// [light prefix, dark prefix, map by light shade, map by pair]
export const PROPS = [
  ['bg', 'dark:bg', BG, BG_BY_PAIR],
  ['hover:bg', 'dark:hover:bg', HOVER_BG, HOVER_BG_BY_PAIR],
  ['group-hover:bg', 'dark:group-hover:bg', HOVER_BG, HOVER_BG_BY_PAIR],
  ['focus:bg', 'dark:focus:bg', HOVER_BG, HOVER_BG_BY_PAIR],
  ['disabled:bg', 'dark:disabled:bg', BG, BG_BY_PAIR],
  ['text', 'dark:text', TEXT, TEXT_BY_PAIR],
  ['hover:text', 'dark:hover:text', TEXT, TEXT_BY_PAIR],
  ['group-hover:text', 'dark:group-hover:text', TEXT, TEXT_BY_PAIR],
  ['focus:text', 'dark:focus:text', TEXT, TEXT_BY_PAIR],
  ['placeholder', 'dark:placeholder', TEXT, TEXT_BY_PAIR],
  ['border', 'dark:border', LINE, LINE_BY_PAIR],
  ['hover:border', 'dark:hover:border', LINE, LINE_BY_PAIR],
  ['focus:border', 'dark:focus:border', LINE, LINE_BY_PAIR],
  ['border-t', 'dark:border-t', LINE, LINE_BY_PAIR],
  ['border-b', 'dark:border-b', LINE, LINE_BY_PAIR],
  ['border-l', 'dark:border-l', LINE, LINE_BY_PAIR],
  ['border-r', 'dark:border-r', LINE, LINE_BY_PAIR],
  ['divide', 'dark:divide', LINE, LINE_BY_PAIR],
];

const SHADE = '(white|neutral-\\d{2,3})';
const esc = (s) => s.replace(/[:-]/g, '\\$&');
const COMPILED = PROPS.map(([light, dark, map, pairMap]) => ({
  light, map, pairMap,
  lightRe: new RegExp(`^${esc(light)}-${SHADE}$`),
  darkRe: new RegExp(`^${esc(dark)}-${SHADE}$`),
}));

/**
 * Find every light/dark pair in a class list that has a token.
 * Returns [{ lightIndex, darkIndex, light, dark, replacement }] over the
 * whitespace-split tokens of `str` (split with the separators kept, so
 * indices map back onto the original string).
 */
export function findTokenPairs(str) {
  const toks = str.split(/(\s+)/);
  const hits = [];
  for (const { light, map, pairMap, lightRe, darkRe } of COMPILED) {
    const li = [], di = [];
    toks.forEach((t, i) => {
      if (lightRe.test(t)) li.push(i);
      else if (darkRe.test(t)) di.push(i);
    });
    if (li.length !== 1 || di.length !== 1) continue;
    const lShade = toks[li[0]].match(lightRe)[1];
    const dShade = toks[di[0]].match(darkRe)[1];
    const token = pairMap[`${lShade}|${dShade}`] || map[lShade];
    if (!token) continue;
    hits.push({ lightIndex: li[0], darkIndex: di[0], light: toks[li[0]], dark: toks[di[0]], replacement: `${light}-${token}` });
  }
  return { toks, hits };
}
