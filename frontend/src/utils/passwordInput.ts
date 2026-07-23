/**
 * Sanitize a guest-entered gallery password before submission (#654).
 *
 * Gallery passwords are usually relayed to guests through chat apps —
 * Instagram DMs especially — and copy-pasting from those surfaces can drag
 * invisible Unicode along with the visible characters: zero-width
 * spaces/joiners (U+200B–U+200D), word joiner (U+2060), BOM (U+FEFF) and
 * soft hyphens (U+00AD). `.trim()` only strips leading/trailing whitespace,
 * so mid-string invisibles survive and fail the backend's byte-exact bcrypt
 * compare with a plain "incorrect password" verdict and no visible cause.
 *
 * Photographer-set event passwords never legitimately contain these
 * characters, so stripping them silently is safe.
 */
const INVISIBLE_CHARS = /[\u200B-\u200D\u2060\uFEFF\u00AD]/g;

export function sanitizePasswordInput(raw: string): string {
  return raw.replace(INVISIBLE_CHARS, '').trim();
}
