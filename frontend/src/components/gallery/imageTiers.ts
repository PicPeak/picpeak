/**
 * Responsive image tiers (#1095).
 *
 * PicPeak serves the same bytes to a 375px phone as to a 4K desktop. The
 * preview tier is a single 1920px JPEG, but a phone can display ~1170px at
 * most — so every lightbox swipe pulls roughly twice the pixels it can use,
 * and the lightbox prefetches neighbours, which multiplies it.
 *
 * The widths mirror the backend whitelist (imageProcessor.js). They are
 * duplicated rather than fetched because they are a contract, not
 * configuration: a value the server does not recognise is ignored and the
 * default tier served, so drift degrades to today's behaviour rather than
 * breaking. The backend test pins the same lists.
 */

export const PREVIEW_WIDTHS = [640, 1280, 1920] as const;

// Thumbnail tiers are NOT here yet. Emitting a srcset whose candidates the
// server ignores is worse than emitting none: the browser would pick the
// "600w" candidate, receive the 300px image, and upscale it — the exact
// softness #1095 reports, made slightly worse. generateThumbnail resolves its
// width from admin settings rather than an argument, so tiering it is a
// separate change and lands separately.

/** Smallest tier that still covers `needed`, or the largest if none does. */
function smallestCovering(needed: number, tiers: readonly number[]): number {
  return tiers.find((w) => w >= needed) ?? tiers[tiers.length - 1];
}

/**
 * Device pixels the viewport can actually show, capped.
 *
 * Capped because devicePixelRatio alone overshoots badly: a DPR-3 phone at
 * 390 CSS px asks for 1170, and a DPR-2 tablet in landscape asks for more
 * than the 1920 we have. Anything above the top tier just returns the top
 * tier, which is what would have been served anyway.
 */
export function viewportPreviewWidth(): number {
  if (typeof window === 'undefined') return PREVIEW_WIDTHS[PREVIEW_WIDTHS.length - 1];
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  return smallestCovering(Math.round(window.innerWidth * dpr), PREVIEW_WIDTHS);
}

/**
 * Downshift one tier when the browser says the connection is poor or the user
 * asked for less data. Both signals are Chromium-only and absent on Safari, so
 * this is a bonus rather than the mechanism — the viewport cap above is what
 * does the real work.
 */
function applyDataSaver(width: number, tiers: readonly number[]): number {
  const conn = (navigator as unknown as {
    connection?: { saveData?: boolean; effectiveType?: string };
  }).connection;
  if (!conn) return width;

  const slow = conn.effectiveType === '2g' || conn.effectiveType === 'slow-2g'
    || conn.effectiveType === '3g';
  if (!conn.saveData && !slow) return width;

  const i = tiers.indexOf(width);
  return i > 0 ? tiers[i - 1] : width;
}

/** Append ?w= to a derivative URL, preserving any existing query string. */
function withWidth(url: string, width: number): string {
  return `${url}${url.includes('?') ? '&' : '?'}w=${width}`;
}

/**
 * The preview URL sized for this device. Returns the input untouched when
 * there is nothing to size — a null preview_url means the caller is about to
 * fall back to the original, and adding ?w= to that would be a lie.
 */
export function previewUrlForViewport(previewUrl: string | null | undefined): string | null {
  if (!previewUrl) return null;
  const width = applyDataSaver(viewportPreviewWidth(), PREVIEW_WIDTHS);
  // The top tier is the default the server already serves; leaving the
  // parameter off keeps those URLs byte-identical to today's, so existing
  // caches and ETags stay valid.
  if (width === PREVIEW_WIDTHS[PREVIEW_WIDTHS.length - 1]) return previewUrl;
  return withWidth(previewUrl, width);
}
