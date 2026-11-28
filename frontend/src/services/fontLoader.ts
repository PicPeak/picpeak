/**
 * Self-hosted font loader. Resolves the available-fonts list once (cached for
 * 5 minutes) and lazily injects @font-face blocks into <head> only for the
 * families a page actually uses. Avoids preloading every available font on
 * every gallery view.
 *
 * Fonts can be uploaded meanwhile (Settings › Branding, issue 2618): the
 * upload forgets the list in its own tab (forgetFontsList), and a family the
 * cached list does not know is looked up again, at most every few seconds,
 * which covers a gallery open in another tab.
 */
import { fontsService, extractFamilyName, fontFaceSource, type FontDefinition } from './fonts.service';

const FONTS_LIST_TTL_MS = 5 * 60 * 1000;
const MISS_RETRY_MS = 10 * 1000;
const FONT_STYLE_ID = 'self-hosted-fonts';

let fontsListPromise: Promise<FontDefinition[]> | null = null;
let fontsListFetchedAt = 0;
// Weights with a @font-face on the page, per family.
const injected = new Map<string, Set<number>>();
// Families already matched against the current list.
const loaded = new Set<string>();

function getFontsList(): Promise<FontDefinition[]> {
  if (fontsListPromise && Date.now() < fontsListFetchedAt + FONTS_LIST_TTL_MS) {
    return fontsListPromise;
  }
  fontsListPromise = fontsService.list().catch((err) => {
    console.error('Failed to load fonts list:', err);
    return [];
  });
  fontsListFetchedAt = Date.now();
  return fontsListPromise;
}

/** Forget the cached list: the next lookup fetches it again (after an upload or a delete). */
export function forgetFontsList(): void {
  fontsListPromise = null;
  fontsListFetchedAt = 0;
  loaded.clear();
}

function ensureFontFaceLoaded(family: string, weights: number[], formats?: FontDefinition['formats']): void {
  const have = injected.get(family) || new Set<number>();
  const missing = weights.filter((w) => !have.has(w));
  if (!missing.length) return;
  missing.forEach((w) => have.add(w));
  injected.set(family, have);

  let styleEl = document.getElementById(FONT_STYLE_ID) as HTMLStyleElement | null;
  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = FONT_STYLE_ID;
    document.head.appendChild(styleEl);
  }

  // Folder name on disk = family name with hyphens (fontFaceSource), in the
  // weight's own format: an uploaded font may be WOFF or TTF.
  const blocks = missing.map(
    (w) => `@font-face{font-family:'${family}';font-style:normal;font-weight:${w};font-display:swap;src:${fontFaceSource(family, w, formats)};}`
  );
  styleEl.textContent += '\n' + blocks.join('\n');
}

const findFamily = (fonts: FontDefinition[], family: string) => fonts.find((f) => f.family.toLowerCase() === family.toLowerCase());

export async function loadFontForFamily(cssFontFamily: string | undefined | null): Promise<void> {
  const family = extractFamilyName(cssFontFamily);
  if (!family || loaded.has(family)) return;
  let match = findFamily(await getFontsList(), family);
  if (!match && Date.now() >= fontsListFetchedAt + MISS_RETRY_MS) {
    // Perhaps uploaded since the list was fetched.
    fontsListFetchedAt = 0;
    match = findFamily(await getFontsList(), family);
  }
  if (!match) return; // unknown family: the browser falls back to the CSS generic
  loaded.add(family);
  ensureFontFaceLoaded(match.family, match.weights, match.formats);
}
