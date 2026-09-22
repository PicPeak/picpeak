'use strict';

/**
 * Stored documents that live in the legacy root (`<cwd>/storage`, where the
 * contract writers put files before they moved onto the shared resolver)
 * rather than under the configured storage root.
 *
 * On a stock install the two are the same directory. When STORAGE_PATH points
 * elsewhere, the rows written before the move still name `<cwd>/storage/...`
 * and resolveStoredPath reads them from there. Both archive kinds (.picpeak
 * and the file backup) walk the configured storage root only, so without this
 * those files never reached an archive, and a restore on another machine lost
 * them.
 *
 * `collectLegacyStoredFiles` lists the ones a row actually names (never the
 * whole directory), each with the storage-relative path it is archived under,
 * and `applyStoredPathMap` rewrites the rows after a backup restore so they
 * name that path (a .picpeak export writes the rows that way directly). The archived path keeps the file's storage suffix, so it lands in the
 * same folder it came from (the per-type read roots in safePath.js allow it).
 * When the configured root already holds a different file at that suffix, the
 * legacy one goes to a `legacy/` folder next to it instead; writers reuse
 * document-number filenames, so the two can hold different bytes.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { getStoragePath } = require('../config/storage');
const {
  STORAGE_FOLDERS, STORED_PATH_COLUMNS, resolveStoredPath, isStorageRelative, storageSuffixes,
} = require('./storedPath');

const toPosix = (p) => p.split(path.sep).join('/');

function isInside(file, root) {
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  return file.startsWith(prefix);
}

function fileHash(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(file).on('error', reject).on('data', (c) => hash.update(c))
      .on('end', () => resolve(hash.digest('hex')));
  });
}

async function sameBytes(a, b) {
  if (fs.statSync(a).size !== fs.statSync(b).size) return false;
  return (await fileHash(a)) === (await fileHash(b));
}

/** A storage-relative path this module may write into a row. */
function isPlaceablePath(rel) {
  if (typeof rel !== 'string' || !rel || rel.includes('\\') || path.posix.isAbsolute(rel)) return false;
  const parts = rel.split('/');
  return STORAGE_FOLDERS.includes(parts[0]) && parts.length > 1
    && parts.every((p) => p && p !== '.' && p !== '..');
}

/**
 * Every legacy-root file a stored-path column names, when the legacy root is
 * outside the storage root's document folders (nothing to do otherwise).
 *
 * @returns {Promise<Array<{ abs: string, rel: string, values: string[], sha256: string }>>}
 *   `rel` is POSIX, relative to the storage root; `values` are the stored
 *   values that name the file.
 */
async function collectLegacyStoredFiles(knex) {
  const root = path.resolve(getStoragePath());
  const legacy = path.resolve(process.cwd(), 'storage');
  const covered = STORAGE_FOLDERS.map((f) => path.join(root, f));
  if (covered.some((dir) => legacy === dir || isInside(legacy, dir))) return [];

  const values = new Set();
  for (const { table, column } of STORED_PATH_COLUMNS) {
    // eslint-disable-next-line no-await-in-loop
    if (!(await knex.schema.hasTable(table)) || !(await knex.schema.hasColumn(table, column))) continue;
    // eslint-disable-next-line no-await-in-loop
    const rows = await knex(table).distinct(column).whereNotNull(column);
    for (const row of rows) if (typeof row[column] === 'string' && row[column]) values.add(row[column]);
  }

  let realLegacy;
  try { realLegacy = fs.realpathSync(legacy); } catch { return []; }
  const byAbs = new Map();
  // Paths under the storage root other rows name or may be moved to (the
  // import relocates a value to any of its storage suffixes), whether or not
  // the file is there: a legacy document must not take one, or a restore
  // would hand that row the legacy document's bytes.
  const reserved = new Set();
  const reserve = (value, resolved) => {
    if (resolved && isInside(resolved, root)) reserved.add(toPosix(path.relative(root, resolved)));
    if (isStorageRelative(value)) reserved.add(toPosix(value));
    else for (const suffix of storageSuffixes(value)) reserved.add(suffix);
  };
  for (const value of values) {
    const resolved = resolveStoredPath(value);
    if (!resolved || !isInside(resolved, legacy) || covered.some((dir) => isInside(resolved, dir))) {
      reserve(value, resolved);
      continue;
    }
    // The readers check the realpath (resolveStoredPathStrict); so does this,
    // so a symlink inside the legacy root cannot pull an outside file into
    // an archive.
    let abs;
    try { abs = fs.realpathSync(resolved); } catch { continue; }
    if (!isInside(abs, realLegacy)) continue;
    let stat;
    try { stat = fs.statSync(abs); } catch { continue; }
    if (!stat.isFile()) continue;
    const suffix = toPosix(path.relative(legacy, resolved));
    if (!isPlaceablePath(suffix)) continue;
    if (!byAbs.has(abs)) byAbs.set(abs, { abs, suffix, values: [] });
    byAbs.get(abs).values.push(value);
  }

  const taken = new Set();
  const out = [];
  for (const entry of [...byAbs.values()].sort((a, b) => a.abs.localeCompare(b.abs))) {
    const dir = path.posix.dirname(entry.suffix);
    const base = path.posix.basename(entry.suffix);
    let rel = entry.suffix;
    for (let n = 1; ; n += 1) {
      const onRoot = path.join(root, ...rel.split('/'));
      // eslint-disable-next-line no-await-in-loop
      const onDisk = fs.existsSync(onRoot);
      const clash = taken.has(rel)
        || (onDisk && !(await sameBytes(onRoot, entry.abs)))
        || (!onDisk && reserved.has(rel));
      if (!clash) break;
      rel = `${dir}/${n === 1 ? 'legacy' : `legacy-${n}`}/${base}`;
    }
    taken.add(rel);
    // eslint-disable-next-line no-await-in-loop
    out.push({ abs: entry.abs, rel, values: entry.values, sha256: await fileHash(entry.abs) });
  }
  return out;
}

/** { storedValue: rel } for a manifest. */
function storedPathMap(files) {
  const map = {};
  for (const f of files) for (const v of f.values || []) map[v] = f.rel;
  return map;
}

/** { rel: sha256 } for a manifest, so a restore can check the bytes. */
function storedPathChecksums(files) {
  const sums = {};
  for (const f of files) if (f.sha256) sums[f.rel] = f.sha256;
  return sums;
}

/**
 * True when `file` holds exactly the bytes `sha256` names. A restore checks
 * this before pointing a row at a mapped path: a file that merely exists
 * there may be a different document (a partial restore, or one written
 * since the backup).
 */
async function holdsBytes(file, sha256) {
  if (typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256)) return false;
  try {
    if (!fs.statSync(file).isFile()) return false;
    return (await fileHash(file)) === sha256;
  } catch {
    return false;
  }
}

/**
 * Rewrite the rows a restored archive's map names to the storage-relative
 * path the file was archived under. Entries whose file is not there with the
 * archived bytes (`verify(rel)` resolving false), or whose target is not a
 * plain storage-relative path (a tampered manifest), are skipped.
 *
 * @returns {Promise<number>} rows updated
 */
async function applyStoredPathMap(knex, map, verify, { onlyUnreadable = false } = {}) {
  if (!map || typeof map !== 'object') return 0;
  const entries = [];
  for (const [value, rel] of Object.entries(map)) {
    if (typeof value !== 'string' || !value || !isPlaceablePath(rel)) continue;
    // Without a restored database the row is the live one: while its own file
    // is still readable, that file is newer than the archived copy.
    if (onlyUnreadable) {
      const current = resolveStoredPath(value);
      if (current && fs.existsSync(current)) continue;
    }
    // eslint-disable-next-line no-await-in-loop
    if (await verify(rel)) entries.push([value, rel]);
  }
  if (!entries.length) return 0;
  let updated = 0;
  for (const { table, column } of STORED_PATH_COLUMNS) {
    // eslint-disable-next-line no-await-in-loop
    if (!(await knex.schema.hasTable(table)) || !(await knex.schema.hasColumn(table, column))) continue;
    for (const [value, rel] of entries) {
      // eslint-disable-next-line no-await-in-loop
      updated += Number(await knex(table).where(column, value).update({ [column]: rel })) || 0;
    }
  }
  return updated;
}

module.exports = {
  collectLegacyStoredFiles,
  storedPathMap,
  storedPathChecksums,
  holdsBytes,
  applyStoredPathMap,
  isPlaceablePath,
};
