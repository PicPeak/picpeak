/**
 * safePath — path-containment helpers for the contract / quote / invoice
 * PDF surfaces.
 *
 * **Why this exists**
 *
 * The audit (#25, #31) flagged that several routes pipe `fs.createReadStream`
 * on a path read directly from the DB (`contracts.pdf_path`,
 * `contracts.signed_pdf_path`) and that `attachSignedPdfUpload` accepts
 * a route-supplied filePath with no containment assertion. The
 * defence-in-depth concern: if a path ever got into the DB pointing
 * outside the legitimate storage roots (via a future migration bug,
 * a hand-edited row, or a SQL-injection regression elsewhere), the
 * stream would happily read /etc/passwd or any other readable file
 * for the requesting admin.
 *
 * Today the DB paths are written by the service layer and never
 * accept caller input directly, so the practical exposure is low —
 * but a 4-line containment check at the read boundary makes the
 * invariant explicit and protects against future drift.
 *
 * **Approach**
 *
 * `assertPathInside(absoluteFilePath, allowedRoots)` resolves both
 * sides to canonical absolute paths via `fs.realpathSync` and
 * verifies the file path starts with one of the allowed root strings
 * followed by a path separator (so /storage-evil/ doesn't pass when
 * /storage/ is allowed). Throws `AppError 403` on violation.
 *
 * `realpathSync` resolves symlinks, defeating the obvious attack
 * (symlink in storage root → /etc/passwd). It throws on missing
 * files, which is fine — callers already exists-check before stream
 * via `fs.existsSync`. We re-throw missing-file errors as
 * AppError 404 to keep the response shape consistent.
 *
 * **What the contract surface uses**
 *
 * Three roots:
 *   1. `<storage root>/business-docs/contract/` — system-stamped PDFs
 *      (immutable as-sent + signed copies) and the signature images
 *      below them. This is where the writers persist.
 *   2. `<cwd>/storage/business-docs/contract/` — the same tree as written
 *      before the writers moved onto the shared storage resolver. Kept so
 *      pre-existing rows, whose absolute paths are in the database, still
 *      resolve; identical to (1) on a stock compose install.
 *   3. `<storage root>/uploads/contracts/signed/` —
 *      wet-upload PDFs (admin or customer-supplied).
 *
 * Both roots are constants from the operator's perspective; legitimate
 * paths always live under one of them.
 */

const fs = require('fs');
const path = require('path');
const { AppError } = require('./errors');
const { getStoragePath } = require('../config/storage');
const { resolveStoredPath } = require('./storedPath');

/**
 * Resolve the canonical (symlink-followed) absolute path. Throws
 * AppError 404 when the file is missing on disk; caller handles
 * the 404 response.
 */
function realpathOr404(absPath) {
  try {
    return fs.realpathSync(absPath);
  } catch (err) {
    if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) {
      throw new AppError('File missing on disk', 404, 'FILE_MISSING');
    }
    throw err;
  }
}

/**
 * Assert that `filePath` resolves to a location inside one of
 * `allowedRoots`. Throws AppError 403 on violation.
 *
 * Both inputs are resolved through realpath so symlinks in either
 * direction are followed before comparison. `allowedRoots` that
 * don't themselves exist are silently dropped from the check (a
 * deployment with both quote and contract roots may have the
 * contract root missing on first boot, for example) — at least one
 * root MUST exist for the check to allow the path.
 */
function assertPathInside(filePath, allowedRoots) {
  if (!filePath) throw new AppError('No path provided', 400);
  const resolvedFile = realpathOr404(filePath);
  const resolvedRoots = [];
  for (const root of allowedRoots) {
    if (!root) continue;
    try {
      const r = fs.realpathSync(root);
      // Append a separator so /storage/foo doesn't match /storage/foo-evil.
      resolvedRoots.push(r.endsWith(path.sep) ? r : r + path.sep);
    } catch (_) {
      // Root doesn't exist yet — fall through. Next iteration may resolve.
    }
  }
  if (resolvedRoots.length === 0) {
    // Defensive: refuse rather than allowing free access when no root
    // exists. Should only happen on a half-provisioned install.
    throw new AppError('No allowed storage roots configured', 500, 'NO_STORAGE_ROOTS');
  }
  const ok = resolvedRoots.some((root) =>
    resolvedFile === root.slice(0, -1) || resolvedFile.startsWith(root)
  );
  if (!ok) {
    throw new AppError('Refusing to serve a file outside the storage roots', 403, 'PATH_OUTSIDE_STORAGE');
  }
  return resolvedFile;
}

/**
 * assertPathInside for a path read from the database. The stored value may be
 * storage-relative or an absolute path recorded by another install; it is
 * placed on this install's storage root first (storedPath.js), and a value
 * that cannot be placed inside it is refused like any other outside path.
 */
function assertStoredPathInside(storedPath, allowedRoots) {
  if (!storedPath) throw new AppError('No path provided', 400);
  const resolved = resolveStoredPath(storedPath);
  if (!resolved) {
    throw new AppError('Refusing to serve a file outside the storage roots', 403, 'PATH_OUTSIDE_STORAGE');
  }
  return assertPathInside(resolved, allowedRoots);
}

/**
 * The directories a stored path may name at all: the storage root, and
 * <cwd>/storage, where the contract writers put files before they moved onto
 * the shared resolver (the same directory on a stock install).
 */
function storageRoots() {
  return [getStoragePath(), path.join(process.cwd(), 'storage')];
}

/**
 * The file a stored path names, for a reader that opens it: placed on this
 * install's storage root, then checked with symlinks followed. Returns null
 * when there is no value or the file is simply not there, so the caller keeps
 * its own "missing" handling. A value that cannot be placed inside
 * `allowedRoots` (tampering, a crafted restore) throws AppError 403.
 */
function resolveStoredPathStrict(storedPath, allowedRoots = storageRoots()) {
  if (!storedPath) return null;
  try {
    return assertStoredPathInside(storedPath, allowedRoots);
  } catch (err) {
    if (err && err.statusCode === 404) return null;
    throw err;
  }
}

/** Where contract PDFs and signature images live (see assertContractPdfPath). */
function contractPdfRoots() {
  const cwd = process.cwd();
  // getStoragePath() rather than a second `STORAGE_PATH || cwd` expression:
  // the two disagree whenever STORAGE_PATH is unset, because the shared
  // resolver falls back module-relative (<repo>/storage) while this file used
  // to fall back to <cwd>/storage — and the backend is normally started from
  // backend/, so those are different directories. The writers use the shared
  // resolver, so a guard with its own idea of the root refuses exactly the
  // files it is meant to serve.
  const storageRoot = getStoragePath();
  return [
    // The configured storage root is where the contract writers persist, so it
    // has to be allowed here or every generated PDF is refused with
    // PATH_OUTSIDE_STORAGE the moment STORAGE_PATH is not <cwd>/storage. The
    // cwd root stays alongside it: contracts written before the writers moved
    // still live there, and their absolute paths are recorded in the database.
    // Both collapse to the same directory on a stock compose install.
    path.join(storageRoot, 'business-docs', 'contract'),
    path.join(cwd, 'storage', 'business-docs', 'contract'),
    path.join(storageRoot, 'uploads', 'contracts', 'signed'),
  ];
}

/**
 * Convenience helper that builds the standard contract PDF roots
 * (system-stamped + wet-upload) and delegates to assertPathInside.
 * Use from contract PDF stream / read sites.
 */
function assertContractPdfPath(filePath) {
  // The stored value may be storage-relative or recorded by another install.
  return assertStoredPathInside(filePath, contractPdfRoots());
}

/**
 * ZIP-slip guard. `node-stream-zip`'s `extract(null, root)` writes each entry
 * to `path.join(root, entry.name)` without neutralising `../` — a crafted
 * archive with an entry named `../../uploads/logos/evil.svg` escapes `root`
 * and overwrites arbitrary files (GHSA-jfhw-fj23-fx6x). Call this with the
 * entry list BEFORE extract() to reject any entry that resolves outside the
 * target directory.
 *
 * Purely lexical (path.resolve, no realpath) because the extraction target
 * does not exist on disk yet. Absolute entry names (`/etc/passwd`) resolve
 * away from `root` and are caught too. Throws AppError 400 on the first
 * offending entry so the whole archive is refused.
 *
 * @param {Array<{name?: string}>} entries  node-stream-zip entry objects
 * @param {string} extractRoot              directory extract() will write into
 */
function assertZipEntriesWithin(entries, extractRoot) {
  const rootResolved = path.resolve(extractRoot);
  const prefix = rootResolved.endsWith(path.sep) ? rootResolved : rootResolved + path.sep;
  for (const entry of entries || []) {
    const name = entry && entry.name;
    if (!name) continue;
    // Backslashes are plain characters to path.resolve on Linux, so
    // `..\..\x` reads as one long filename that stays inside the root. The
    // storage backends turn them into '/' before normalising, and so would
    // an extract on Windows, so the check has to see the same path they do.
    const target = path.resolve(rootResolved, name.replace(/\\/g, '/'));
    if (target !== rootResolved && !target.startsWith(prefix)) {
      throw new AppError(
        `Archive contains an entry that escapes the extraction directory: ${name}`,
        400,
        'ZIP_SLIP'
      );
    }
  }
}

/**
 * Resolve a stored `/uploads/<kind>/<file>` URL to the file it names inside
 * that upload directory, or null when the value is not one of ours.
 *
 * Only the basename is trusted: the URL comes from an admin-writable
 * setting, and `path.join(storage, url)` after a `startsWith('/uploads/…')`
 * check still collapses `..` segments, so it could name any file the process
 * can delete. Restricting to a flat leaf inside the fixed directory is the
 * whole control -- the upload routes only ever write flat filenames there.
 *
 * @param {string} url          stored value, e.g. "/uploads/logos/logo-1.png"
 * @param {string} kind         "logos" | "favicons"
 * @param {string} storageRoot  the root the writer used (callers differ)
 */
function uploadedAssetPath(url, kind, storageRoot) {
  if (!url || typeof url !== 'string') return null;
  const prefix = `/uploads/${kind}/`;
  if (!url.startsWith(prefix)) return null;
  const leaf = url.slice(prefix.length);
  if (!leaf || leaf === '.' || leaf === '..' || path.basename(leaf) !== leaf) return null;
  return path.join(storageRoot, 'uploads', kind, leaf);
}

/**
 * Resolve business_profile.logo_path to the file the PDF-logo upload route
 * wrote, or null. logo_path is a free-text field on the profile PUT (an
 * admin may point it at a file managed elsewhere), so it must never be
 * unlinked as given: a `/pdf-logo-\d+\./` marker test plus path.join let
 * `pdf-logo-1./../../../<anything>` -- or any absolute path containing the
 * marker -- delete arbitrary files. Only a flat `pdf-logo-<n>.<ext>` leaf
 * inside uploads/logos is ever named.
 *
 * With `imageOnly`, only the image extensions the upload route writes are
 * accepted: that is the check for a logo_path an admin sets. Cleanup keeps
 * the default, so a non-image `pdf-logo-*` file written before the upload
 * derived its extension from the MIME type is still removed on replace.
 */
const PDF_LOGO_IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.svg'];

function uploadedPdfLogoPath(logoPath, storageRoot, { imageOnly = false } = {}) {
  if (!logoPath || typeof logoPath !== 'string') return null;
  const normalized = logoPath.replace(/^\/+/, '');
  const match = /^uploads\/logos\/(pdf-logo-\d+\.[A-Za-z0-9]+)$/.exec(normalized);
  if (!match) return null;
  if (imageOnly && !PDF_LOGO_IMAGE_EXTENSIONS.includes(path.extname(match[1]).toLowerCase())) return null;
  return path.join(storageRoot, 'uploads', 'logos', match[1]);
}

/**
 * Extensions the public /uploads/logos and /uploads/favicons trees serve.
 * Every upload route that writes there accepts only these image types, but
 * older versions kept the client's extension, so a file named .html or .js
 * can still be on disk from before. It is not served from the app origin.
 */
const PUBLIC_UPLOAD_IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico'];

function isPublicUploadImage(filePath) {
  return PUBLIC_UPLOAD_IMAGE_EXTENSIONS.includes(path.extname(String(filePath || '')).toLowerCase());
}

module.exports = {
  assertPathInside,
  assertStoredPathInside,
  resolveStoredPathStrict,
  storageRoots,
  contractPdfRoots,
  assertContractPdfPath,
  assertZipEntriesWithin,
  uploadedAssetPath,
  uploadedPdfLogoPath,
  isPublicUploadImage,
  PUBLIC_UPLOAD_IMAGE_EXTENSIONS,
};
