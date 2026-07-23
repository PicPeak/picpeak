/**
 * Strip invisible Unicode from a guest-submitted gallery password (#654).
 *
 * Gallery passwords are usually relayed to guests through chat apps —
 * Instagram DMs especially — and copy-pasting from those surfaces drags
 * invisible characters along with the visible ones: zero-width
 * space/joiners (U+200B–U+200D), word joiner (U+2060), BOM (U+FEFF), soft
 * hyphen (U+00AD). Those fail the byte-exact bcrypt compare with a plain
 * "incorrect password" verdict and no visible cause.
 *
 * Used by the gallery verify route as a same-request compare fallback: the
 * exact submitted bytes are always tried first, so stored passwords that
 * legitimately contain these characters keep working.
 */
const INVISIBLE_CHARS = /[\u200B-\u200D\u2060\uFEFF\u00AD]/g;

function sanitizePasswordInput(raw) {
  return String(raw).replace(INVISIBLE_CHARS, '').trim();
}

module.exports = { sanitizePasswordInput };
