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

/** Fallback tier for face avatars when the face's size in frame is unknown. */
export const FACE_CROP_WIDTH = 640;

/** CSS px of the avatar the crop has to fill; used to size the tier. */
const FACE_AVATAR_PX = 64;

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
 * Device pixels the image's LONG EDGE will occupy, capped.
 *
 * The long edge specifically, because that is what the server's `w` bounds:
 * it resizes with fit:'inside', so `w` caps both dimensions. Sizing from
 * viewport WIDTH alone undersizes portraits — on a 390x844 phone at DPR 3 a
 * 2:3 photo is contained by height and renders ~1755 device px tall, so
 * picking by width lands on 1280 and makes portrait photos softer than they
 * are today. Landscape on the same phone genuinely needs only ~1170.
 *
 * DPR is capped at 3: uncapped, a DPR-10 device asks for thousands of pixels
 * and lands back on the desktop rendition, which is the thing being fixed.
 *
 * Without photo dimensions there is nothing to reason about, so it falls back
 * to the largest edge the viewport could possibly demand — which resolves to
 * the top tier, i.e. exactly today's behaviour.
 */
export function viewportPreviewWidth(photo?: { width?: number | null; height?: number | null }): number {
  if (typeof window === 'undefined') return PREVIEW_WIDTHS[PREVIEW_WIDTHS.length - 1];
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  const pw = photo?.width;
  const ph = photo?.height;
  if (!pw || !ph) {
    return smallestCovering(Math.round(Math.max(vw, vh) * dpr), PREVIEW_WIDTHS);
  }

  // Contained in the viewport, so one axis binds; the rendered long edge is
  // the source long edge times that scale.
  const scale = Math.min(vw / pw, vh / ph);
  const renderedLongEdge = Math.max(pw, ph) * scale * dpr;
  return smallestCovering(Math.round(renderedLongEdge), PREVIEW_WIDTHS);
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
export function previewUrlForViewport(
  previewUrl: string | null | undefined,
  photo?: { width?: number | null; height?: number | null },
): string | null {
  if (!previewUrl) return null;
  const width = applyDataSaver(viewportPreviewWidth(photo), PREVIEW_WIDTHS);
  // The top tier is the default the server already serves; leaving the
  // parameter off keeps those URLs byte-identical to today's, so existing
  // caches and ETags stay valid.
  if (width === PREVIEW_WIDTHS[PREVIEW_WIDTHS.length - 1]) return previewUrl;
  return withWidth(previewUrl, width);
}

/**
 * An aspect-preserved rendition for a face avatar (#1096).
 *
 * NOT the thumbnail. faceCropStyle positions the crop by scaling the whole
 * frame and offsetting so the face lands centre — which holds only while the
 * rendition IS the whole frame. thumbnail_fit is seeded to 'cover' (migration
 * 040_add_thumbnail_settings), so thumbnails are centre-cropped on essentially
 * every install and every avatar rendered against one is silently offset. It
 * presents as a bad detector: a shoulder, the back of a head, a patch of
 * background.
 *
 * Previews use fit: 'inside', so they are the whole frame. 640 is plenty for a
 * 64px avatar even at DPR 3, and face scanning has already generated a preview
 * for any photo that has a face — faceProcessor calls ensurePreviewImage to
 * get something to scan — so this asks for a rendition that is already there.
 */
export function facePreviewUrl(
  slug: string | undefined,
  photo: {
    id: number | string;
    preview_url?: string | null;
    width?: number | null;
    height?: number | null;
  } | null | undefined,
  cover?: { bbox: number[] } | null,
): string | null {
  if (!photo) return null;
  const width = faceTierWidth(photo, cover);

  // preview_url carries the watermark query when the server emitted one, so
  // prefer it; it is only absent when lightbox previews are off.
  if (photo.preview_url) return withWidth(photo.preview_url, width);
  if (!slug) return null;

  // Carry admin_preview through. verifyGalleryAccess only accepts the admin
  // cookie when admin_preview=1 is on the request (middleware/gallery.js:28),
  // and the preview flow deliberately mints no gallery JWT — so a synthesized
  // URL without it 401s, and every avatar breaks in exactly the mode an admin
  // uses to check their gallery before sending it.
  const adminPreview = typeof window !== 'undefined'
    && new URLSearchParams(window.location.search).get('admin_preview') === '1'
    ? '&admin_preview=1'
    : '';
  return `/api/gallery/${slug}/preview/${photo.id}?w=${width}${adminPreview}`;
}

/**
 * Tier for a face crop, sized by how much of the frame the face occupies.
 *
 * A fixed small tier is wrong for the case that matters most: in a 6000px
 * group shot a 200px face is only ~21px at the 640 tier, and faceCropStyle
 * then blows that up ~9x to fill a 64px avatar at DPR 3 — visibly mush, and
 * indistinguishable from the mis-positioning bug this was meant to fix.
 *
 * Working back from the avatar: the frame must be large enough that the
 * bbox's share of it still covers the avatar's device pixels. A close-up
 * lands on 640, a face across a hall lands on 1920.
 */
function faceTierWidth(
  photo: { width?: number | null; height?: number | null },
  cover?: { bbox: number[] } | null,
): number {
  const avatarDevicePx = FACE_AVATAR_PX
    * (typeof window !== 'undefined' ? Math.min(window.devicePixelRatio || 1, 3) : 2);

  const frameLongEdge = Math.max(photo.width || 0, photo.height || 0);
  const bboxLongEdge = cover?.bbox ? Math.max(cover.bbox[2] || 0, cover.bbox[3] || 0) : 0;
  if (!frameLongEdge || !bboxLongEdge) return FACE_CROP_WIDTH;

  const faceShareOfFrame = bboxLongEdge / frameLongEdge;
  return smallestCovering(Math.round(avatarDevicePx / faceShareOfFrame), PREVIEW_WIDTHS);
}

/** Admin equivalent — the admin API has its own preview route. */
export function adminFacePreviewUrl(
  eventId: number | string,
  photoId: number | string,
  photo?: { width?: number | null; height?: number | null },
  cover?: { bbox: number[] } | null,
): string {
  const width = photo ? faceTierWidth(photo, cover) : FACE_CROP_WIDTH;
  return `/api/admin/photos/${eventId}/preview/${photoId}?w=${width}`;
}
