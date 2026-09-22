'use strict';

/**
 * Uploaded PDF fonts (#1445): a family an admin adds for their documents,
 * next to the bundled ones.
 *
 * Each face (regular, and optionally bold and italic) is checked by content
 * in a worker (utils/fontValidation) — TTF/OTF only, size, glyph count,
 * required tables, and the font's own embedding permission — and stored
 * once under business-docs/fonts/<sha256>.<ttf|otf>, which backups include.
 * The admin names it, writes a licence note and confirms the right to embed
 * it. A theme refers to it as `upload-<id>`; the theme service resolves that
 * to file paths before a render, so the renderer (in its worker, without a
 * database) only ever sees server-resolved paths. Fonts are archived, never
 * deleted: a theme or a generated document's record may name one. An
 * archived font no longer resolves, and documents fall back to Helvetica —
 * which the template check reports as FONT_MISSING.
 */

const fs = require('fs');
const path = require('path');
const { db, logActivity } = require('../../database/db');
const { AppError } = require('../../utils/errors');
const { isUniqueViolation } = require('../../utils/dbErrors');
const { getStoragePath } = require('../../config/storage');
const { assertPathInside } = require('../../utils/safePath');
const { validateFont } = require('../../utils/fontValidation');

const FOLDER = path.join('business-docs', 'fonts');
const STYLES = { regular: '400', bold: '700', italic: '400i' };
const FAMILY_PREFIX = 'upload-';
const truthy = (v) => v === true || v === 1 || v === '1';
const insertedId = (rows) => (typeof rows[0] === 'object' ? rows[0].id : rows[0]);

const familyOf = (id) => `${FAMILY_PREFIX}${id}`;
const idOfFamily = (family) => {
  const match = /^upload-(\d+)$/.exec(String(family || ''));
  return match ? Number(match[1]) : null;
};

function fontsRoot() {
  return path.join(getStoragePath(), FOLDER);
}

function toApi(row, files) {
  return {
    id: row.id,
    family: familyOf(row.id),
    name: row.display_name,
    licenceNote: row.licence_note,
    licenceAcknowledgedAt: row.licence_acknowledged_at || null,
    isActive: truthy(row.is_active),
    createdAt: row.created_at,
    files: files.map((f) => ({ style: f.style, sha256: f.sha256, bytes: Number(f.bytes) })),
  };
}

async function listFonts() {
  if (!(await db.schema.hasTable('pdf_fonts'))) return [];
  const rows = await db('pdf_fonts').orderBy('display_name', 'asc');
  const files = rows.length ? await db('pdf_font_files').whereIn('font_id', rows.map((r) => r.id)) : [];
  return rows.map((row) => toApi(row, files.filter((f) => Number(f.font_id) === Number(row.id))));
}

/** Families a theme may pick: `[{ family, name }]` for the active uploaded fonts. */
async function uploadedFamilies() {
  if (!(await db.schema.hasTable('pdf_fonts'))) return [];
  const rows = await db('pdf_fonts').where({ is_active: true }).orderBy('display_name', 'asc');
  return rows.map((row) => ({ family: familyOf(row.id), name: row.display_name }));
}

/** Every uploaded family name, archived ones included. */
async function allFamilies() {
  if (!(await db.schema.hasTable('pdf_fonts'))) return [];
  return (await db('pdf_fonts').select('id')).map((row) => familyOf(row.id));
}

/** Write checked bytes once, named by their content. */
function writeFile(buffer, info) {
  const storageKey = path.join(FOLDER, `${info.sha256}.${info.format}`);
  const absolute = path.join(getStoragePath(), storageKey);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  if (!fs.existsSync(absolute)) {
    const temp = `${absolute}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temp, buffer);
    fs.renameSync(temp, absolute);
  }
  return storageKey;
}

/**
 * Check and store a font. `files` maps regular / bold / italic to Buffers;
 * regular is required. Returns the font as the API shows it.
 */
async function storeFont({ name, licenceNote, licenceAcknowledged, files = {}, acknowledgedAt }, adminId) {
  const displayName = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 64);
  if (!displayName) throw new AppError('A font needs a name', 400, 'FONT_INVALID');
  const note = String(licenceNote || '').trim();
  if (!note || note.length > 500) throw new AppError('Describe the font\'s licence (up to 500 characters)', 400, 'FONT_LICENCE_NOTE_REQUIRED');
  if (licenceAcknowledged !== true) {
    throw new AppError('Confirm that you have the right to embed this font in documents', 400, 'FONT_LICENCE_NOT_CONFIRMED');
  }
  if (!files.regular) throw new AppError('Upload at least the regular face', 400, 'FONT_INVALID');

  // Every face is checked before anything is stored.
  const checked = [];
  for (const [key, style] of Object.entries(STYLES)) {
    if (!files[key]) continue;
    checked.push({ style, buffer: files[key], info: await validateFont(files[key]) });
  }
  const stored = checked.map((face) => ({ ...face, storageKey: writeFile(face.buffer, face.info) }));

  const now = new Date().toISOString();
  let id;
  try {
    id = await db.transaction(async (trx) => {
      const fontId = insertedId(await trx('pdf_fonts').insert({
        display_name: displayName,
        licence_note: note,
        // When the admin confirmed the right to embed it; null for the font
        // moved from the earlier setting, which nobody confirmed here.
        licence_acknowledged_at: acknowledgedAt === undefined ? now : acknowledgedAt,
        uploaded_by_admin_id: adminId || null,
        is_active: true,
        created_at: now,
        updated_at: now,
      }).returning('id'));
      await trx('pdf_font_files').insert(stored.map((face) => ({
        font_id: fontId, style: face.style, storage_key: face.storageKey, sha256: face.info.sha256,
        bytes: face.info.bytes, created_at: now,
      })));
      return fontId;
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new AppError('A font with this name exists already', 409, 'FONT_NAME_TAKEN');
    throw err;
  }
  try {
    await logActivity('pdf_font_uploaded', { fontId: id, styles: stored.map((f) => f.style) }, null, `admin:${adminId}`);
  } catch (_) { /* non-fatal */ }
  return (await listFonts()).find((font) => font.id === id);
}

async function archiveFont(id, adminId) {
  const updated = await db('pdf_fonts').where({ id }).update({ is_active: false, updated_at: new Date().toISOString() });
  if (!updated) throw new AppError('Font not found', 404, 'FONT_NOT_FOUND');
  try {
    await logActivity('pdf_font_archived', { fontId: id }, null, `admin:${adminId}`);
  } catch (_) { /* non-fatal */ }
  return (await listFonts()).find((font) => font.id === Number(id));
}

/**
 * The files of an active uploaded family, `{ body, bold, italic }` absolute
 * paths (bold and italic fall back to regular), or null.
 */
async function fontFilesFor(family) {
  const id = idOfFamily(family);
  if (!id || !(await db.schema.hasTable('pdf_fonts'))) return null;
  const font = await db('pdf_fonts').where({ id, is_active: true }).first();
  if (!font) return null;
  const rows = await db('pdf_font_files').where({ font_id: id });
  const byStyle = Object.fromEntries(rows.map((row) => {
    try {
      return [row.style, assertPathInside(path.join(getStoragePath(), row.storage_key), [fontsRoot()])];
    } catch (_) {
      return [row.style, null];
    }
  }));
  const body = byStyle['400'];
  if (!body) return null;
  return { body, bold: byStyle['700'] || body, italic: byStyle['400i'] || body };
}

/**
 * The retired free-text font path (business_profile.pdf_font_ttf_path) —
 * where it was looked for, for the one-time move below.
 */
function legacyFontFile(raw) {
  const storageRoot = getStoragePath();
  const candidates = [
    path.isAbsolute(raw) ? raw : null,
    path.join(storageRoot, raw.replace(/^\/+/, '')),
    path.join(storageRoot, 'fonts', path.basename(raw)),
    path.join(process.cwd(), 'storage', raw.replace(/^\/+/, '')),
    path.join(process.cwd(), 'storage', 'fonts', path.basename(raw)),
  ].filter(Boolean);
  const found = candidates.find((file) => {
    try { return fs.existsSync(file) && fs.statSync(file).isFile(); } catch (_) { return false; }
  });
  return found && /\.(ttf|otf)$/i.test(found) ? found : null;
}

const LEGACY_NAME = 'Custom font (earlier setting)';
// Why the move failed, for the fonts card: `{ reason, path, at }`.
const LEGACY_FAILURE_SETTING = 'pdf_font_legacy_move_failure';

/**
 * Record why the earlier font could not be moved, then clear the column: the
 * failure is shown once on the fonts card instead of a warning at every boot
 * while documents quietly use Helvetica.
 */
async function recordLegacyFailure(raw, reason, logger) {
  const { upsertAppSetting } = require('../../utils/appSettings');
  await upsertAppSetting(LEGACY_FAILURE_SETTING, JSON.stringify({ reason, path: raw, at: new Date().toISOString() }), 'json');
  const { auditedUpdate } = require('../accountingHistory');
  await auditedUpdate(db, 'business_profile', { id: 1 }, { pdf_font_ttf_path: null }, { source: 'pdf.fonts.legacy_migration' });
  logger.warn('The earlier custom PDF font could not be moved; documents use Helvetica', { path: raw, reason });
  return null;
}

/** The recorded failure of that move, or null. */
async function legacyMoveFailure() {
  const { getAppSetting } = require('../../utils/appSettings');
  const value = await getAppSetting(LEGACY_FAILURE_SETTING, null);
  return value && typeof value === 'object' ? value : null;
}

/**
 * Boot: move a still-set pdf_font_ttf_path into an uploaded font, point every
 * theme row at it (the old path won over every theme, so this keeps the
 * documents' look), and clear the column. The renderer no longer reads the
 * column. A file that is gone or fails the checks is logged and left; it no
 * longer applies. Safe to run twice and from two processes (the unique name
 * lets one insert win).
 */
async function migrateLegacyFont(logger = require('../../utils/logger')) {
  if (!(await db.schema.hasTable('pdf_fonts')) || !(await db.schema.hasTable('business_profile'))) return null;
  if (!(await db.schema.hasColumn('business_profile', 'pdf_font_ttf_path'))) return null;
  const profile = await db('business_profile').where({ id: 1 }).first();
  const raw = profile && profile.pdf_font_ttf_path ? String(profile.pdf_font_ttf_path) : null;
  if (!raw) return null;
  const file = legacyFontFile(raw);
  if (!file) return recordLegacyFailure(raw, 'FONT_FILE_NOT_FOUND', logger);
  // The size before reading: the column held any path an admin typed.
  if (fs.statSync(file).size > require('../../utils/fontValidation').MAX_BYTES) {
    return recordLegacyFailure(raw, 'FONT_TOO_LARGE', logger);
  }
  let font;
  try {
    font = await storeFont({
      name: LEGACY_NAME,
      licenceNote: 'Moved from the earlier custom font setting. Check that its licence allows embedding in documents.',
      licenceAcknowledged: true,
      acknowledgedAt: null,
      files: { regular: fs.readFileSync(file) },
    }, null);
  } catch (err) {
    if (err && err.code === 'FONT_NAME_TAKEN') {
      const row = await db('pdf_fonts').where({ display_name: LEGACY_NAME }).first();
      font = row ? { id: row.id, family: familyOf(row.id) } : null;
    } else {
      return recordLegacyFailure(raw, (err && err.code) || 'FONT_MALFORMED', logger);
    }
  }
  if (!font) return null;
  const themeModel = require('./theme');
  const rows = await db('pdf_themes').select('scope', 'settings');
  const scopes = new Set(rows.map((r) => r.scope));
  const now = new Date().toISOString();
  for (const row of rows) {
    const settings = { ...themeModel.parseSettings(row.settings), fontFamily: font.family };
    await db('pdf_themes').where({ scope: row.scope }).update({ settings: JSON.stringify(settings), updated_at: now });
  }
  if (!scopes.has('default')) {
    try {
      await db('pdf_themes').insert({ scope: 'default', settings: JSON.stringify({ fontFamily: font.family }), created_at: now, updated_at: now });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
    }
  }
  // business_profile is an audited table: the change goes through the recorder.
  const { auditedUpdate } = require('../accountingHistory');
  await auditedUpdate(db, 'business_profile', { id: 1 }, { pdf_font_ttf_path: null }, { source: 'pdf.fonts.legacy_migration' });
  logger.info('Moved the earlier custom PDF font into the uploaded fonts', { fontId: font.id });
  return font;
}

module.exports = {
  FOLDER,
  STYLES,
  familyOf,
  idOfFamily,
  listFonts,
  uploadedFamilies,
  allFamilies,
  storeFont,
  archiveFont,
  fontFilesFor,
  migrateLegacyFont,
  legacyMoveFailure,
};
