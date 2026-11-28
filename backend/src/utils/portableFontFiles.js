'use strict';
/**
 * Which files under fonts/ travel in a .picpeak export and come back with its
 * import (issue 2618): one rule for both sides, so an export is always
 * importable. A family folder holds its weight files and meta.json, and may
 * hold what a font download brings along: its licence (OFL.txt, LICENSE*),
 * notes (README*, FONTLOG*, *.txt). Those are text, never served (the /fonts
 * mounts serve font files only, secureStatic.isPublicFontFile), and kept
 * small; anything else (an HTML page, a script) stays out.
 */
const FONT_OR_META = /^fonts\/[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*\/(?:\d{1,4}\.(?:woff2|woff|ttf)|meta\.json)$/;
const COMPANION = /^fonts\/[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*\/(?:(?:OFL|LICEN[CS]E|README|FONTLOG|COPYING|AUTHORS)(?:[._-][A-Za-z0-9._-]{0,40})?|[A-Za-z0-9][A-Za-z0-9._-]{0,60}\.txt)$/i;
const MAX_COMPANION_BYTES = 128 * 1024;

/** A path (POSIX, under the storage root) that may travel. */
function portableFontPath(rel) {
  return FONT_OR_META.test(rel) || COMPANION.test(rel);
}

/** A file that the export takes: the path, and a companion text no larger than 128 KB. */
function portableFontFile(rel, size) {
  if (FONT_OR_META.test(rel)) return true;
  return COMPANION.test(rel) && Number(size) <= MAX_COMPANION_BYTES;
}

module.exports = { portableFontPath, portableFontFile, MAX_COMPANION_BYTES };
