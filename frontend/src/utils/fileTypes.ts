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

// Extensions that also go into `accept` by name. A file chooser matches accept
// MIME types against the operating system's own type table, and macOS, iOS and
// Windows do not map .dng to image/x-adobe-dng, so the MIME type alone hid
// every DNG from the chooser (issue 821).
const ACCEPT_BY_EXTENSION = new Set(['dng']);

/**
 * Convert a comma-separated extension string to an HTML `accept` attribute
 * value, e.g. "image/jpeg,image/png,video/mp4" (plus ".dng" when DNG is on).
 */
export function extensionsToAcceptString(extString?: string | null): string {
  const mimeTypes = extensionsToMimeTypes(extString);
  const byName = Array.from(ACCEPT_BY_EXTENSION)
    .filter((ext) => mimeTypes.includes(EXTENSION_TO_MIME[ext]))
    .map((ext) => `.${ext}`);
  return [...mimeTypes, ...byName].join(',');
}

// What browsers report for a .dng besides image/x-adobe-dng: which one depends
// on the OS type table, and a machine without a RAW codec reports nothing.
const DNG_TYPE_ALIASES = new Set(['', 'application/octet-stream', 'image/dng', 'image/x-dng', 'image/tiff']);

/**
 * The MIME type to validate a picked file against. Mirrors the backend's
 * normalizeUploadMimeType, which the server applies before its own checks.
 */
export function normalizeFileMimeType(name: string, type: string): string {
  if (/\.dng$/i.test(name) && DNG_TYPE_ALIASES.has(type)) return EXTENSION_TO_MIME.dng;
  return type;
}

/**
 * `accept` for the guest upload input (#1117).
 *
 * Chrome and Edge on Android 14/15 route an `<input>` whose accept list is
 * entirely image and video types to the system *photo picker*, which has no
 * camera tile — so a guest standing at the event can only pick a photo already
 * in their gallery, never take one. Adding a value that picker cannot satisfy
 * makes Chrome fall back to the general document chooser, which does offer the
 * camera.
 *
 * `android/allowCamera` is the token the workaround converged on. It is not a
 * real MIME type and matches no file, which is the point: it flips the picker
 * without advertising anything extra as selectable. An earlier revision used
 * `.pdf`, which works by the same mechanism but offers PDFs in the chooser —
 * pick one and you get "Invalid file type" for your trouble.
 *
 * Gated to Android MINUS Firefox. The behaviour is Chromium's — Chrome and
 * Edge on Android 14/15 — and Firefox for Android, whose UA also says
 * `Android`, opens a chooser that already offers the camera. Handing it a
 * token invented to reroute a picker it does not use is at best inert and at
 * worst changes a chooser that was working.
 *
 * UA sniffing is the wrong tool in general, but there is no feature query for
 * "which picker will this open", and the failure mode of a wrong guess is an
 * accept token the browser ignores.
 *
 * Neither token widens what is actually accepted: `addFiles` validates every
 * file against `extensionsToMimeTypes`, which only ever emits types it has a
 * mapping for, so nothing new can get past it.
 */
export function buildUploadAcceptString(extString?: string | null, userAgent?: string): string {
  const accept = extensionsToAcceptString(extString);
  const ua = userAgent ?? (typeof navigator !== 'undefined' ? navigator.userAgent : '');
  const needsCameraToken = /Android/i.test(ua) && !/Firefox/i.test(ua);
  return needsCameraToken ? `${accept},android/allowCamera` : accept;
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
