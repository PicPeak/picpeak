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
  // Browsers report no type at all for most of these, so the upload components
  // fall back to matching on the extension. Kept in sync with the backend map.
  dng: 'image/x-adobe-dng',
  arw: 'image/x-sony-arw',
  sr2: 'image/x-sony-sr2',
  srf: 'image/x-sony-srf',
  cr2: 'image/x-canon-cr2',
  nef: 'image/x-nikon-nef',
  nrw: 'image/x-nikon-nrw',
  orf: 'image/x-olympus-orf',
  pef: 'image/x-pentax-pef',
  srw: 'image/x-samsung-srw',
};

/**
 * Extensions no browser puts a type on.
 *
 * macOS and Windows register no MIME for camera RAW, so `file.type` is an
 * empty string for a .arw the user just picked, and some Linux desktops report
 * application/octet-stream. Matching on `file.type` alone drops those files
 * before they are ever uploaded.
 *
 * Kept in step with the backend's RAW set by
 * backend/__tests__/services/uploadSettingsFileTypes.test.js. Widening it here
 * without widening it there would let the picker accept a file the server then
 * rejects, which is a worse experience than the greyed-out picker.
 */
const UNTYPED_EXTENSIONS = new Set([
  'dng', 'arw', 'sr2', 'srf', 'cr2', 'nef', 'nrw', 'orf', 'pef', 'srw',
]);

const extensionOf = (filename: string): string =>
  filename.toLowerCase().split('.').pop() || '';

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
 *
 * The untyped extensions are also listed in their dotted form. A file chooser
 * matches accept MIME types against the operating system's own type table,
 * and macOS, iOS and Windows map none of the RAW extensions, so the MIME type
 * alone hid every DNG from the chooser (issue 821) and greys out a .arw. Only
 * those extensions get a token, so a default install's accept string is
 * unchanged - which matters on Android, where a non-MIME token reroutes the
 * system picker (see buildUploadAcceptString).
 */
export function extensionsToAcceptString(extString?: string | null): string {
  const mimeTypes = extensionsToMimeTypes(extString);
  const dotted = (extString?.trim() || DEFAULT_ALLOWED)
    .split(',')
    .map(ext => ext.trim().toLowerCase().replace(/^\./, ''))
    .filter(ext => UNTYPED_EXTENSIONS.has(ext) && EXTENSION_TO_MIME[ext])
    .map(ext => `.${ext}`);
  return [...mimeTypes, ...Array.from(new Set(dotted))].join(',');
}

// What a browser reports for a RAW file when it reports anything at all. The
// OS type table decides, so a DNG can arrive as image/dng or image/tiff, and a
// machine with no RAW codec reports nothing.
const GENERIC_RAW_TYPES = new Set(['', 'application/octet-stream', 'image/dng', 'image/x-dng', 'image/tiff']);

/**
 * The MIME type an upload should be judged as.
 *
 * Mirrors normalizeUploadMimeType in backend/src/utils/fileSecurityUtils.js,
 * and has to keep mirroring it: if this is looser, the picker accepts files
 * the server then rejects with a message about system settings.
 */
export function normalizeFileMimeType(name: string, type: string): string {
  const ext = extensionOf(name);
  if (UNTYPED_EXTENSIONS.has(ext) && GENERIC_RAW_TYPES.has((type || '').trim())) {
    return EXTENSION_TO_MIME[ext] || type;
  }
  return type;
}

/**
 * Is this file one the configured settings accept?
 */
export function isAllowedUploadFile(
  file: { name: string; type: string },
  allowedMimeTypes: string[]
): boolean {
  const mime = normalizeFileMimeType(file.name, file.type);
  return !!mime && allowedMimeTypes.includes(mime);
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
 * file through `isAllowedUploadFile`, which only ever resolves to a type the
 * map has, so nothing new can get past it.
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
