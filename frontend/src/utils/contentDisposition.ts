/**
 * Parse the `filename` out of a `Content-Disposition` response header.
 *
 * Prefers the RFC 5987 form (`filename*=UTF-8''<percent-encoded>`) so unicode
 * camera filenames round-trip correctly, and falls back to the plain
 * `filename="..."` token. Returns null when the header is missing or
 * unparseable so the caller can choose its own fallback (typically the
 * client-side photo.filename).
 *
 * Why this exists: backend download routes emit a Content-Disposition with
 * the user-facing filename (which may be the original camera name when the
 * #493 toggle is on). The frontend used to override that with a hardcoded
 * `<a download="X">` attribute, so the server's filename never reached
 * disk. Reading it back from the response means the server stays the
 * single source of truth.
 */
export function parseContentDispositionFilename(header: string | null | undefined): string | null {
  if (!header) return null;

  // RFC 5987: filename*=UTF-8''<percent-encoded-bytes>
  // The optional language tag (e.g. UTF-8'en'foo.jpg) is rarely emitted by
  // servers; we accept the empty case only since that's what we produce.
  const star = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(header);
  if (star && star[1]) {
    try {
      return decodeURIComponent(star[1].trim());
    } catch {
      // Malformed percent-encoding — fall through to the plain form.
    }
  }

  // Plain quoted form: filename="..."
  const quoted = /filename\s*=\s*"([^"]+)"/i.exec(header);
  if (quoted && quoted[1]) {
    return quoted[1];
  }

  // Plain unquoted form: filename=... (terminated by ; or end-of-string)
  const unquoted = /filename\s*=\s*([^;]+)/i.exec(header);
  if (unquoted && unquoted[1]) {
    return unquoted[1].trim();
  }

  return null;
}
