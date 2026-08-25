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
}): string {
  // No format is excluded any more. This used to bypass the preview tier for
  // GIF, APNG and PNG because generatePreviewImage always encoded JPEG, which
  // has neither an alpha channel nor a second frame — so a transparent source
  // came back flattened and an animated one came back as a still. That is
  // fixed at the source: previews of alpha or multi-page images are now WebP,
  // which carries both, and the guess-by-MIME this file could never make
  // correctly (a still and an animated WebP declare the same type) is gone
  // with it — including the filename fallback the previous commit needed
  // because migration 039 made mime_type untrustworthy.
  return photo.preview_url || photo.slideshow_url || photo.url;
}
