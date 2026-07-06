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
 * Two roots:
 *   1. `<cwd>/storage/business-docs/contract/<year>/` — system-stamped
 *      PDFs (immutable as-sent + signed copies).
 *   2. `<STORAGE_PATH or cwd/storage>/uploads/contracts/signed/` —
 *      wet-upload PDFs (admin or customer-supplied).
 *
 * Both roots are constants from the operator's perspective; legitimate
 * paths always live under one of them.
 */

const fs = require('fs');
const path = require('path');
const { AppError } = require('./errors');

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
 * Convenience helper that builds the standard contract PDF roots
 * (system-stamped + wet-upload) and delegates to assertPathInside.
 * Use from contract PDF stream / read sites.
 */
function assertContractPdfPath(filePath) {
  const cwd = process.cwd();
  const storageRoot = process.env.STORAGE_PATH || path.join(cwd, 'storage');
  return assertPathInside(filePath, [
    path.join(cwd, 'storage', 'business-docs', 'contract'),
    path.join(storageRoot, 'uploads', 'contracts', 'signed'),
  ]);
}

module.exports = {
  assertPathInside,
  assertContractPdfPath,
};
