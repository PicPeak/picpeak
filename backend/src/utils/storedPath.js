'use strict';

/**
 * Paths to files under the storage root, as the database records them.
 *
 * Generated PDFs, signature images, wet-signed uploads and inbound documents
 * used to be recorded as absolute paths. An absolute path names one install's
 * storage directory: after a `.picpeak` restore onto another storage path,
 * after moving the storage directory, or when the same database is used from
 * a container (`/app/storage/...`) and from the host, every one of those rows
 * pointed at a directory that is not there, so sent contracts, signed PDFs and
 * certificates could not be opened and the integrity checks reported them
 * missing although the bytes had been restored.
 *
 * New rows record the path relative to the storage root (`toStoredPath`), and
 * every read goes through `resolveStoredPath`, which accepts both shapes:
 *
 *   - relative (`business-docs/contract/2026/C-1.pdf`): joined onto the
 *     current storage root;
 *   - absolute under the current storage root: used as it is;
 *   - absolute under another storage root: mapped onto the current root by
 *     its storage-relative part, the suffix from a top-level storage folder
 *     (`business-docs/` or `uploads/`) on. When a path has more than one such
 *     segment, the candidate that exists on disk wins, last segment first;
 *   - absolute under `<cwd>/storage`, the root the contract writers used
 *     before they moved onto the shared resolver: used as it is when the file
 *     is there and has no copy under the current root.
 *
 * Whatever comes out stays inside the current storage root (or that legacy
 * root): a relative path with `..` segments that climb out, or an absolute
 * path with no storage folder in it, resolves to null and the caller refuses
 * it. The check here is lexical. Readers that open a file use
 * `resolveStoredPathStrict` / `assertStoredPathInside` (safePath.js), which
 * add `assertPathInside` on the realpath against the folder the file belongs
 * in. The lexical form alone is used only where no bytes are read from the
 * row's target: an existence check before a strict read, email attachment
 * paths (checked strictly by emailProcessor when the email is sent), the
 * event-logo unlink (unlink removes a symlink, not its target), and cleanup
 * of files this process just wrote.
 *
 * Nothing here changes a file's bytes or a stored hash: only which path the
 * row names for the same file.
 */

const fs = require('fs');
const path = require('path');
const { getStoragePath } = require('../config/storage');

/** Top-level storage folders the stored paths live under. */
const STORAGE_FOLDERS = ['business-docs', 'uploads'];

/**
 * Every column that records a file under the storage root. The `.picpeak`
 * import and the migration that converts existing rows walk this list.
 * (This release has no generated_documents or contract_signers table.)
 */
const STORED_PATH_COLUMNS = [
  { table: 'quotes', column: 'pdf_path' },
  { table: 'invoices', column: 'pdf_path' },
  { table: 'invoices', column: 'imported_pdf_path' },
  { table: 'contracts', column: 'pdf_path' },
  { table: 'contracts', column: 'signed_pdf_path' },
  { table: 'contracts', column: 'signed_customer_signature_path' },
  { table: 'contracts', column: 'signed_admin_signature_path' },
  { table: 'inbound_documents', column: 'file_path' },
  { table: 'expenses', column: 'receipt_path' },
  { table: 'events', column: 'hero_logo_path' },
];

const storageRoot = () => path.resolve(getStoragePath());
const legacyRoot = () => path.resolve(process.cwd(), 'storage');

function isInside(file, root) {
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  return file.startsWith(prefix);
}

const toPosix = (p) => p.split(path.sep).join('/');

/**
 * The storage-relative paths an absolute path could stand for: the suffix
 * from each top-level storage folder segment, last segment first. The
 * storage root is the prefix, so a folder name further in is more likely to
 * be the real one than one in the directories above the root.
 */
function storageSuffixes(absPath) {
  const segments = path.resolve(absPath).split(path.sep);
  const suffixes = [];
  for (let i = segments.length - 2; i >= 0; i -= 1) {
    if (STORAGE_FOLDERS.includes(segments[i])) suffixes.push(segments.slice(i).join('/'));
  }
  return suffixes;
}

/**
 * The value to record for a file this install just wrote: relative to the
 * storage root when the file is inside it, unchanged otherwise.
 */
function toStoredPath(filePath) {
  if (!filePath || typeof filePath !== 'string' || !path.isAbsolute(filePath)) return filePath;
  const abs = path.resolve(filePath);
  const root = storageRoot();
  return isInside(abs, root) ? toPosix(path.relative(root, abs)) : filePath;
}

/**
 * A stored value rewritten for this install: relative to the storage root
 * when it is under it, else its storage-relative suffix when it has one
 * (a path recorded by another install). `exists(relative)` picks between
 * suffixes when there is more than one. Anything else comes back unchanged.
 */
function relocateStoredPath(value, exists = null) {
  if (!value || typeof value !== 'string' || !path.isAbsolute(value)) return value;
  const own = toStoredPath(value);
  if (own !== value) return own;
  const suffixes = storageSuffixes(value);
  if (!suffixes.length) return value;
  return (exists && suffixes.find((s) => exists(s))) || suffixes[0];
}

/**
 * The absolute path of a stored file on this install, or null when the value
 * cannot be placed inside the storage root. Does not require the file to
 * exist (the caller reports a missing file); it only uses existence to choose
 * between candidates.
 */
function resolveStoredPath(value) {
  if (!value || typeof value !== 'string') return null;
  const root = storageRoot();
  if (!path.isAbsolute(value)) {
    const abs = path.resolve(root, value);
    return isInside(abs, root) ? abs : null;
  }
  const abs = path.resolve(value);
  if (isInside(abs, root)) return abs;
  const candidates = storageSuffixes(abs)
    .map((s) => path.resolve(root, s))
    .filter((c) => isInside(c, root));
  const existing = candidates.find((c) => fs.existsSync(c));
  if (existing) return existing;
  if (isInside(abs, legacyRoot()) && fs.existsSync(abs)) return abs;
  return candidates[0] || null;
}

module.exports = {
  STORAGE_FOLDERS,
  STORED_PATH_COLUMNS,
  toStoredPath,
  relocateStoredPath,
  resolveStoredPath,
};
