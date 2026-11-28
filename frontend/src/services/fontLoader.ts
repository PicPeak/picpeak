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
// The @font-face on the page: per family, per weight, its source. The
// style element is written from this, so a face whose file changed (another
// format) or went away is replaced, not left pointing at a deleted file.
const faces = new Map<string, Map<number, string>>();
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

function writeFaces(): void {
  let styleEl = document.getElementById(FONT_STYLE_ID) as HTMLStyleElement | null;
  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = FONT_STYLE_ID;
    document.head.appendChild(styleEl);
  }
  const blocks: string[] = [];
  faces.forEach((weights, family) => weights.forEach((src, w) => {
    blocks.push(`@font-face{font-family:'${family}';font-style:normal;font-weight:${w};font-display:swap;src:${src};}`);
  }));
  styleEl.textContent = blocks.join('\n');
}

/** The family's faces as the list has them now: added, changed or removed weights. */
function syncFontFaces(font: FontDefinition): void {
  // Folder name on disk = family name with hyphens (fontFaceSource), in the
  // weight's own format: an uploaded font may be WOFF or TTF.
  const next = new Map(font.weights.map((w) => [w, fontFaceSource(font.family, w, font.formats, font.versions)] as [number, string]));
  const current = faces.get(font.family);
  const same = current && current.size === next.size && [...next].every(([w, src]) => current.get(w) === src);
  if (same) return;
  faces.set(font.family, next);
  writeFaces();
}

const findFamily = (fonts: FontDefinition[], family: string) => fonts.find((f) => f.family.toLowerCase() === family.toLowerCase());

export async function loadFontForFamily(cssFontFamily: string | undefined | null): Promise<void> {
  const family = extractFamilyName(cssFontFamily);
  // A family already matched is compared again once the list is old.
  if (!family || (loaded.has(family) && Date.now() < fontsListFetchedAt + FONTS_LIST_TTL_MS)) return;
  let match = findFamily(await getFontsList(), family);
  if (!match && Date.now() >= fontsListFetchedAt + MISS_RETRY_MS) {
    // Perhaps uploaded since the list was fetched.
    fontsListFetchedAt = 0;
    match = findFamily(await getFontsList(), family);
  }
  if (!match) {
    // Unknown (or deleted since): the browser falls back to the CSS generic.
    loaded.delete(family);
    if (faces.delete(family)) writeFaces();
    return;
  }
  loaded.add(family);
  syncFontFaces(match);
}
