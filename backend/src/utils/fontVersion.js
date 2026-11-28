/**
 * A font file's version in its address (`/fonts/<Family>/<weight>.<ext>?v=…`):
 * made here and recognised here, so the maker (the font list) and the
 * readers (the website's @font-face, the read-through of stored fonts)
 * agree on its shape.
 */

/**
 * From the file's modification time and size, so a replaced file gets a new
 * address (browsers cache /fonts for a week, and the object-store copy on
 * each replica for minutes).
 */
function fileVersion(mtime, size) {
  const ms = mtime instanceof Date ? mtime.getTime() : Number(mtime);
  return `${Number.isFinite(ms) ? Math.floor(ms).toString(36) : ''}${Number(size || 0).toString(36)}`;
}

const FONT_VERSION_PATTERN = /^[a-z0-9]{1,40}$/;

module.exports = { fileVersion, FONT_VERSION_PATTERN };
