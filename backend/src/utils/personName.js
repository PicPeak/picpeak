/**
 * The one sanitiser for a person's name that other people get to read (#1561).
 *
 * Moved out of routes/galleryGuests.js, where it only covered guest
 * registration. A photo credit now reaches the same audience from three
 * sources — the guest's own name, an EXIF Artist/Creator/Copyright string
 * from whatever camera or editor wrote the file, and the admin's correction —
 * and all three are untrusted text shown to other guests. Applied when the
 * value is written, never at render, so every reader sees the same string.
 *
 * On top of the original rules (markup characters, control characters,
 * whitespace collapsed, 100 characters) this strips the invisible characters
 * that let a name impersonate another one or reorder the text around it:
 * zero-width joiners/spaces, the BOM, and the bidi embedding / override /
 * isolate controls ("Anna" + U+202E + "gnp.exe" style tricks).
 */

const MAX_NAME_LEN = 100;

// C0 and C1 controls plus DEL.
// eslint-disable-next-line no-control-regex -- intentional: strips control chars from untrusted names
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F]/g;
// Zero-width space/non-joiner/joiner, word joiner, BOM, soft hyphen, the LRM/RLM/ALM
// marks, and the bidi embeddings, overrides and isolates.
const INVISIBLE_CHARS = /[\u00AD\u061C\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;

function sanitizeName(value, maxLength = MAX_NAME_LEN) {
  if (typeof value !== 'string') return '';
  const cleaned = value
    // Apostrophes stay ("O'Brien", "D’Angelo"): a name is rendered as React
    // text, escaped by escapeXml in the XMP sidecar, and formula-neutralised
    // and quoted in the CSV exports, so none of them needs it removed.
    .replace(/[<>&"]/g, '')
    .replace(CONTROL_CHARS, ' ')
    .replace(INVISIBLE_CHARS, '')
    .replace(/\s+/g, ' ')
    .trim();
  // Array.from so the cap never splits a surrogate pair in half.
  return Array.from(cleaned).slice(0, maxLength).join('').trim();
}

module.exports = { sanitizeName, MAX_NAME_LEN };
