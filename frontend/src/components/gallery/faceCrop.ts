/**
 * Shared face-crop geometry (#1074).
 *
 * Extracted because three surfaces need identical maths and two of them
 * originally shipped without it: the "Show all" sheet and the admin People
 * manager rendered centred full-photo thumbnails, so on any group photo the
 * avatar showed whoever happened to be in the middle — often not the person
 * it was labelling, and identical for two people from the same photo.
 *
 * The bbox is in ORIGINAL image pixels; the rendered thumbnail is some other
 * size. Everything is therefore done in RATIOS of the source dimensions, which
 * survives whatever rendition the browser is actually served.
 */

export interface FaceBox {
  bbox: [number, number, number, number];
}

/**
 * Style for an <img> inside a square, overflow-hidden, position-relative box
 * of `size` px, such that `bbox` lands centred and filling it.
 *
 * Returns null when the source dimensions are unknown — the caller should then
 * fall back to an uncropped thumbnail rather than render a wrongly-offset crop.
 */
export function faceCropStyle(
  cover: FaceBox | null | undefined,
  photoWidth: number | undefined,
  photoHeight: number | undefined,
  size: number,
): React.CSSProperties | null {
  if (!cover || !photoWidth || !photoHeight) return null;
  const [bx, by, bw, bh] = cover.bbox;
  if (!bw || !bh) return null;

  // Detectors crop tight to the face; a little padding reads as a portrait
  // rather than a specimen.
  const pad = 0.45;
  const cx = bx + bw / 2;
  const cy = by + bh / 2;
  const side = Math.max(bw, bh) * (1 + pad);

  const scale = size / side;
  return {
    width: `${photoWidth * scale}px`,
    height: `${photoHeight * scale}px`,
    maxWidth: 'none',
    position: 'absolute',
    left: `${size / 2 - cx * scale}px`,
    top: `${size / 2 - cy * scale}px`,
  };
}
