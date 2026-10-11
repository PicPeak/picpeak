'use strict';

// Everything that can refuse a .picpeak before the instance is touched. The
// import route runs this inside the upload request, while the application is
// fully up: a refused archive costs the operator an error message, not a
// maintenance window. The worker repeats it on the staged copy.
const fsp = require('fs').promises;
const archive = require('./portableImportArchive');
const recoveryFiles = require('./recoveryFiles');
const { getStoragePath } = require('../config/storage');

const RUNTIME_TABLES = new Set(require('../utils/restoreRuntimeTables'));
const SHA256 = /^[a-f0-9]{64}$/;
const helpers = () => require('./picpeakImportService');
const refuse = (message, code, statusCode = 400) => Object.assign(new Error(message), { code, statusCode });

// The exporter has no per-file ceiling, so the importer takes what the
// manifest records. A file the manifest does not describe (archives from
// before the catalogue) is held to the largest upload this instance allows.
async function fileCeiling() {
  let configured = 0;
  try {
    const settings = require('./uploadSettings');
    configured = Math.max(await settings.getMaxFileSizeBytes(), await settings.getMaxVideoSizeBytes());
  } catch (_) { /* Settings unreadable: the recovery default applies. */ }
  return Math.max(recoveryFiles.DEFAULT_MAX_BYTES, Number.isSafeInteger(configured) ? configured : 0);
}

function catalogue(manifest) {
  const result = new Map();
  if (manifest.files === undefined || manifest.files === null) return result;
  if (!Array.isArray(manifest.files) || manifest.files.length > archive.limits().entries) throw refuse('Invalid portable file catalogue', 'RESTORE_MANIFEST_INVALID');
  for (const file of manifest.files) {
    if (!file || typeof file !== 'object') throw refuse('Invalid portable file catalogue entry', 'RESTORE_MANIFEST_INVALID');
    let key;
    try { key = recoveryFiles.validKey(file.path); recoveryFiles.objectOptions(file.object_metadata); }
    catch (error) { throw refuse(error.message, 'RESTORE_MANIFEST_INVALID'); }
    if (result.has(key) || helpers().importFilePathProblem(key) || !Number.isSafeInteger(file.size)
        || file.size < 0 || typeof file.checksum !== 'string'
        || !SHA256.test(file.checksum)) throw refuse('Invalid portable file size/checksum', 'RESTORE_MANIFEST_INVALID');
    result.set(key, file);
  }
  return result;
}

// The cutover suspends foreign keys with session_replication_role and takes
// ACCESS EXCLUSIVE on every table. Find out now whether this role may.
async function assertRestorePrivileges(db) {
  if (!['pg', 'postgres', 'postgresql'].includes(db.client.config.client)) return;
  let denied = 0;
  try {
    await db.transaction(async trx => {
      await trx.raw('SET LOCAL session_replication_role = \'replica\'');
      const result = await trx.raw(`SELECT count(*)::int AS denied FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT has_table_privilege(c.oid, 'DELETE')`);
      denied = result.rows[0].denied;
    });
  } catch (_) {
    throw refuse('The PostgreSQL role of this instance cannot run a restore: it needs SUPERUSER (session_replication_role). '
      + 'Managed PostgreSQL application users usually lack it.', 'RESTORE_PRIVILEGE_MISSING');
  }
  if (denied) throw refuse(`The PostgreSQL role of this instance cannot replace ${denied} table(s) it does not own.`, 'RESTORE_PRIVILEGE_MISSING');
}

async function preflightArchive(archivePath, { db = require('../database/db').db, storageRoot = getStoragePath() } = {}) {
  let manifest;
  try { manifest = await helpers().readManifestFromZip(archivePath); }
  catch (error) {
    if (error.code) throw error;
    throw refuse('The file is not a readable PicPeak backup (.picpeak).', 'RESTORE_MANIFEST_INVALID');
  }
  const blockers = await helpers().validateManifest(manifest);
  if (blockers.length) throw refuse(blockers[0], 'RESTORE_MANIFEST_INVALID');
  const recorded = catalogue(manifest);
  const allTables = (await require('./picpeakExportService').listDataTables()).filter(table => !RUNTIME_TABLES.has(table));
  const zip = await archive.openBoundedArchive(archivePath, { validateFileKey: helpers().importFilePathProblem, allowedTables: new Set(allTables) });
  let census;
  try {
    const entries = Object.values(await zip.entries());
    census = archive.archiveCensus(entries, { validateFileKey: helpers().importFilePathProblem, allowedTables: new Set(allTables) });
    const ceiling = await fileCeiling();
    const sizes = new Map();
    for (const entry of entries) if (!entry.isDirectory && entry.name.startsWith('files/')) sizes.set(entry.name.slice(6), entry.size);
    for (const [key, file] of recorded) {
      if (sizes.get(key) !== file.size) throw refuse(`The backup's file list does not match its contents: ${key}`, 'RESTORE_MANIFEST_INVALID');
    }
    for (const [key, size] of sizes) {
      if (!recorded.has(key) && size > ceiling) throw refuse(`A file in the backup is larger than this instance accepts: ${key}`, 'RESTORE_ARCHIVE_LIMIT', 413);
    }
  } finally { await zip.close(); }
  // Extracted once and staged once more next to the files they replace.
  let free;
  try {
    const stats = await fsp.statfs(storageRoot, { bigint: true });
    free = stats.bavail * stats.bsize;
  } catch (_) { throw refuse('Free space on the storage volume cannot be measured.', 'RESTORE_CAPACITY_UNKNOWN', 507); }
  const needed = 2n * BigInt(census.expandedBytes) + BigInt(archive.HARD_LIMITS.reserveBytes);
  if (free < needed) {
    throw refuse(`The restore needs about ${Math.ceil(Number(needed) / 1024 ** 2)} MiB free on the storage volume; ${Math.floor(Number(free) / 1024 ** 2)} MiB are available.`, 'RESTORE_CAPACITY_LIMIT', 507);
  }
  await assertRestorePrivileges(db);
  return { entries: census.entries, expandedBytes: census.expandedBytes, largestBytes: census.largestBytes,
    tables: Object.keys(manifest.tables || {}).length };
}

module.exports = { preflightArchive, catalogue, fileCeiling, assertRestorePrivileges };
