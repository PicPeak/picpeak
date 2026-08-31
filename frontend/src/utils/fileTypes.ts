/**
 * Maps file extensions to MIME types for upload validation.
 */
const EXTENSION_TO_MIME: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  avi: 'video/x-msvideo',
  // HEIC/HEIF (iPhone) — kept in sync with the backend EXTENSION_TO_MIME.
  heic: 'image/heic',
  heif: 'image/heif',
  // Camera RAW / Apple ProRAW — backend extracts the embedded JPEG preview.
  dng: 'image/x-adobe-dng',
};

const DEFAULT_ALLOWED = 'jpg,jpeg,png,webp';

/**
 * Convert a comma-separated extension string (e.g. "jpg,png,mp4") to an
 * array of unique MIME types.
 */
export function extensionsToMimeTypes(extString?: string | null): string[] {
  const input = extString?.trim() || DEFAULT_ALLOWED;
  const mimeSet = new Set<string>();

  input.split(',').forEach(ext => {
    const cleaned = ext.trim().toLowerCase().replace(/^\./, '');
    const mime = EXTENSION_TO_MIME[cleaned];
    if (mime) {
      mimeSet.add(mime);
    }
  });

  if (mimeSet.size === 0) {
    return extensionsToMimeTypes(DEFAULT_ALLOWED);
  }

  return Array.from(mimeSet);
}

/**
 * Convert a comma-separated extension string to an HTML `accept` attribute
 * value, e.g. "image/jpeg,image/png,video/mp4".
 */
export function extensionsToAcceptString(extString?: string | null): string {
  return extensionsToMimeTypes(extString).join(',');
}

/**
 * `accept` for the guest upload input (#1117).
 *
 * Recent Android versions route an `<input>` whose accept list is entirely
 * image and video types to the system *photo picker*, which has no camera
 * entry — so a guest at the event cannot take a photo, only pick one already
 * in their gallery. Including a type the photo picker can't handle forces
 * Android back to the general document chooser, which does offer the camera.
 *
 * Gated on the UA because iOS and desktop pickers behave correctly and would
 * only gain a selectable PDF that `addFiles` then rejects. Picking one on
 * Android is rejected the same way — `extensionsToMimeTypes` only ever emits
 * types it has a mapping for, so `application/pdf` can never be in the
 * allowlist and the existing "Invalid file type" guard already covers it.
 *
 * UA sniffing is the wrong tool in general, but there is no feature query for
 * "which picker will this open"; the failure mode of a wrong guess is one
 * extra unusable entry in a file chooser.
 */
export function buildUploadAcceptString(extString?: string | null, userAgent?: string): string {
  const accept = extensionsToAcceptString(extString);
  const ua = userAgent ?? (typeof navigator !== 'undefined' ? navigator.userAgent : '');
  return /Android/i.test(ua) ? `${accept},.pdf` : accept;
}

/**
 * Human-readable, de-duplicated list of the configured extensions for the
 * upload requirements hint, e.g. "JPG, PNG, WEBP, MOV". Only extensions the
 * app actually supports (present in EXTENSION_TO_MIME) are shown, so the hint
 * never advertises a format the backend would reject.
 */
export function extensionsToLabel(extString?: string | null): string {
  const input = extString?.trim() || DEFAULT_ALLOWED;
  const seen = new Set<string>();
  const labels: string[] = [];
  input.split(',').forEach(ext => {
    const cleaned = ext.trim().toLowerCase().replace(/^\./, '');
    if (cleaned && EXTENSION_TO_MIME[cleaned] && !seen.has(cleaned)) {
      seen.add(cleaned);
      labels.push(cleaned.toUpperCase());
    }
  });
  if (labels.length === 0) return extensionsToLabel(DEFAULT_ALLOWED);
  return labels.join(', ');
}
