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
 * Gated on the UA because iOS, desktop and Firefox pickers behave correctly.
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
  return /Android/i.test(ua) ? `${accept},android/allowCamera` : accept;
}
