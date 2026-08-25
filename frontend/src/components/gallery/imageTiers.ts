/**
 * Which rendition a surface should display.
 *
 * On `main` this file also carries the responsive tier machinery (#1095) —
 * `previewUrlForViewport`, `thumbnailUrlForTile`, the width tables. None of
 * that is on this branch, so URLs here are used as the server emits them. The
 * filename matches main deliberately, so that when #1095 is backported it
 * merges into this file rather than landing beside it.
 */

/**
 * What the lightbox actually puts in an <img> (#1166).
 *
 * `preview_url` is only emitted when the admin has flipped
 * lightbox_preview_enabled, which is off by default — so a stock install fell
 * straight through to `url`, the untouched original. A reporter measured
 * 16.5 MB per photo where the preview is 345 KB, and the lightbox renders its
 * neighbours too, so opening one photo pulled three originals.
 *
 * `slideshow_url` is the same /preview/:id URL, watermark query and all, but
 * emitted unconditionally for images (#1015) — the slideshow has never had a
 * fallback worth taking. Preferring it here fixes every existing install
 * without an admin touching a setting.
 *
 * `url` stays as the last resort, which is where videos land (both derivative
 * URLs are null for them) and where an image goes if the server ever stops
 * emitting either. The preview route generates lazily and redirects to the
 * original on any failure, so nothing here can show less than it does today.
 */
export function lightboxImageUrl(photo: {
  url: string;
  preview_url?: string | null;
  slideshow_url?: string | null;
  mime_type?: string;
}): string {
  // Animated and transparent formats keep the original. generatePreviewImage
  // encodes JPEG, which has neither a second frame nor an alpha channel, so
  // routing these through the preview tier would replace an animation with its
  // first frame and flatten transparency onto a solid background — a
  // regression the toggle-off default never had.
  //
  // PNG is in the list because that is where transparency is the norm, and
  // because an APNG is normally reported as image/png rather than image/apng.
  // Animated or alpha WebP declares image/webp exactly like an ordinary still
  // and cannot be told apart from MIME.
  //
  // The proper fix is backend-side, encoding WebP for alpha or multi-page
  // sources; when that lands this list goes away entirely.
  const ORIGINAL_ONLY = ['image/gif', 'image/apng', 'image/png'];
  if (photo.mime_type && ORIGINAL_ONLY.includes(photo.mime_type)) return photo.url;

  return photo.preview_url || photo.slideshow_url || photo.url;
}
