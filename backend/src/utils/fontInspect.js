'use strict';

/**
 * Content checks for an uploaded PDF font (#1445). Judged by the bytes,
 * never the file name:
 *   - TrueType (00 01 00 00) or OpenType/CFF ("OTTO") only — WOFF, WOFF2 and
 *     font collections are refused, as is anything else;
 *   - at most 5 MB and 65 535 glyphs;
 *   - every table the directory lists lies inside the file (a truncated
 *     upload is refused rather than half-read);
 *   - the tables a PDF renderer needs: cmap, glyf or CFF, head, hhea, hmtx,
 *     name;
 *   - the font's own embedding permission (OS/2 fsType): "restricted licence
 *     embedding", "no subsetting" and "bitmap embedding only" are refused —
 *     PDFKit embeds a subset of the outlines, which such a font forbids.
 * Runs in a worker (utils/fontValidation).
 */

const crypto = require('crypto');
const { AppError } = require('./errors');

const MAX_BYTES = 5 * 1024 * 1024;
const MAX_GLYPHS = 65535;
const REQUIRED = ['cmap', 'head', 'hhea', 'hmtx', 'name'];

const refuse = (message, code) => new AppError(message, 400, code);

function inspectFont(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) throw refuse('This is not a font file', 'FONT_NOT_A_FONT');
  if (buffer.length > MAX_BYTES) throw refuse('A font file may be at most 5 MB', 'FONT_TOO_LARGE');
  const magic = buffer.subarray(0, 4).toString('latin1');
  const trueType = buffer.readUInt32BE(0) === 0x00010000;
  if (['wOFF', 'wOF2', 'ttcf'].includes(magic)) {
    throw refuse('Upload the font as a TTF or OTF file (WOFF, WOFF2 and font collections are not supported)', 'FONT_FORMAT_UNSUPPORTED');
  }
  if (!trueType && magic !== 'OTTO') throw refuse('This is not a TTF or OTF font file', 'FONT_NOT_A_FONT');

  let font;
  try {
    // eslint-disable-next-line global-require
    font = require('fontkit').create(buffer);
  } catch (_) {
    throw refuse('The font file could not be read', 'FONT_MALFORMED');
  }
  const tables = (font.directory && font.directory.tables) || {};
  for (const entry of Object.values(tables)) {
    if (!entry || entry.offset + entry.length > buffer.length) throw refuse('The font file is incomplete', 'FONT_MALFORMED');
  }
  const missing = REQUIRED.filter((tag) => !tables[tag]);
  if (!tables.glyf && !tables['CFF ']) missing.push('glyf');
  if (missing.length) throw refuse(`The font is missing required tables: ${missing.join(', ')}`, 'FONT_MALFORMED');

  let numGlyphs;
  let fsType;
  let familyName;
  try {
    numGlyphs = font.numGlyphs;
    fsType = font['OS/2'] ? font['OS/2'].fsType : null;
    familyName = font.familyName || null;
    // Touch what the renderer will read: metrics and a glyph run.
    void font.head.unitsPerEm; // eslint-disable-line no-void
    void font.hhea.ascent; // eslint-disable-line no-void
    font.layout('Ag');
  } catch (_) {
    throw refuse('The font file could not be read', 'FONT_MALFORMED');
  }
  if (!Number.isFinite(numGlyphs) || numGlyphs > MAX_GLYPHS) throw refuse('The font has too many glyphs', 'FONT_TOO_COMPLEX');
  if (fsType && fsType.noEmbedding) {
    throw refuse('This font\'s licence does not allow embedding it in documents', 'FONT_LICENCE_RESTRICTED');
  }
  // PDFKit always embeds a subset of the glyphs used, and embeds outlines.
  if (fsType && fsType.noSubsetting) {
    throw refuse('This font\'s licence does not allow embedding a subset of it, which PDFs need', 'FONT_NO_SUBSETTING');
  }
  if (fsType && fsType.bitmapOnly) {
    throw refuse('This font\'s licence only allows embedding bitmaps, not the outlines PDFs need', 'FONT_BITMAP_ONLY');
  }
  return {
    format: trueType ? 'ttf' : 'otf',
    bytes: buffer.length,
    sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
    numGlyphs,
    familyName: familyName ? String(familyName).slice(0, 64) : null,
  };
}

module.exports = { MAX_BYTES, MAX_GLYPHS, inspectFont };
