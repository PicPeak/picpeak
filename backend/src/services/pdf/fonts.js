'use strict';

/**
 * PDF fonts (#1445): the regular, bold and italic faces a document uses.
 *
 * Resolution, as before plus an italic slot:
 *   1. the legacy single uploaded TTF (business_profile.pdf_font_ttf_path) —
 *      one file for every face;
 *   2. a bundled family (backend/assets/fonts/<Family>/): 400 → 500 → 600 →
 *      700 for regular, 700 → 600 → 500 → 400 for bold, `400i.ttf` for
 *      italic. A family without an italic file uses its upright regular
 *      rather than a synthetic slant;
 *   3. PDFKit's built-in Helvetica / Helvetica-Bold / Helvetica-Oblique.
 *
 * The web font picker (fontsService) only lists `<digits>.woff2`, so the
 * italic TTFs never show up as extra families there.
 */

const fs = require('fs');
const path = require('path');
const { getStoragePath } = require('../../config/storage');

const FONTS_ROOT = path.resolve(__dirname, '../../../assets/fonts');
const HELVETICA = Object.freeze({ body: 'Helvetica', bold: 'Helvetica-Bold', italic: 'Helvetica-Oblique' });
const CUSTOM = Object.freeze({ body: 'crm-body', bold: 'crm-bold', italic: 'crm-italic' });

const exists = (file) => {
  try { return fs.existsSync(file); } catch (_) { return false; }
};
const firstExisting = (dir, names) => names.map((n) => path.join(dir, n)).find(exists) || null;

function legacyFontFile(raw) {
  // The configured storage root first; process.cwd()/storage stays on as a
  // legacy fallback so installs predating STORAGE_PATH keep resolving.
  const storageRoot = getStoragePath();
  const candidates = [
    path.isAbsolute(raw) ? raw : null,
    path.join(storageRoot, raw.replace(/^\/+/, '')),
    path.join(storageRoot, 'fonts', path.basename(raw)),
    path.join(process.cwd(), 'storage', raw.replace(/^\/+/, '')),
    path.join(process.cwd(), 'storage', 'fonts', path.basename(raw)),
  ].filter(Boolean);
  const found = candidates.find(exists);
  return found && /\.(ttf|otf)$/i.test(found) ? found : null;
}

/** The files for `{ pdfFontTtfPath, fontFamily }`, or null for Helvetica. */
function resolveFontFiles({ pdfFontTtfPath, fontFamily } = {}) {
  if (pdfFontTtfPath) {
    const file = legacyFontFile(String(pdfFontTtfPath));
    if (file) return { body: file, bold: file, italic: file };
  }
  if (fontFamily) {
    // The family name comes from a saved setting: strip anything that could
    // walk out of the fonts directory.
    const family = String(fontFamily).replace(/[^A-Za-z0-9_-]/g, '');
    if (family) {
      const dir = path.join(FONTS_ROOT, family);
      const body = firstExisting(dir, ['400.ttf', '500.ttf', '600.ttf', '700.ttf']);
      const bold = firstExisting(dir, ['700.ttf', '600.ttf', '500.ttf', '400.ttf']);
      if (body && bold) {
        return { body, bold, italic: firstExisting(dir, ['400i.ttf', '500i.ttf']) || body };
      }
    }
  }
  return null;
}

/**
 * Register the faces on a PDFKit document. Returns the logical names to
 * pass to doc.font(), or null when the document stays on Helvetica.
 */
function registerFonts(doc, options) {
  const files = resolveFontFiles(options);
  if (!files) return null;
  try {
    doc.registerFont(CUSTOM.body, files.body);
    doc.registerFont(CUSTOM.bold, files.bold);
    doc.registerFont(CUSTOM.italic, files.italic);
    return { ...CUSTOM };
  } catch (_) {
    return null;
  }
}

/** Bundled families that have at least a regular TTF. */
function availableFamilies() {
  try {
    return fs.readdirSync(FONTS_ROOT, { withFileTypes: true })
      .filter((e) => e.isDirectory() && exists(path.join(FONTS_ROOT, e.name, '400.ttf')))
      .map((e) => e.name)
      .sort();
  } catch (_) {
    return [];
  }
}

module.exports = {
  HELVETICA,
  CUSTOM,
  FONTS_ROOT,
  resolveFontFiles,
  registerFonts,
  availableFamilies,
};
