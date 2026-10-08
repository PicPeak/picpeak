const fs = require('fs').promises;
const path = require('path');

const { getStoragePath } = require('../config/storage');

const STANDALONE_VERSION = 'standalone-v1';
const STANDALONE_SNAPSHOT_RE = /^backup-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function hasControlCharacters(value) {
  return Array.from(value).some(character => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
}

function isStandaloneRestorePoint(manifest) {
  return manifest?.metadata?.restore_point === STANDALONE_VERSION;
}

function assertCompleteFileRestore(manifest, options) {
  const marker = manifest?.metadata?.restore_point;
  if (marker != null && marker !== STANDALONE_VERSION) {
    throw new Error('Unsupported backup restore-point format');
  }
  if (isStandaloneRestorePoint(manifest)) {
    if (manifest.backup?.type !== 'full' || manifest.backup.parent_backup_id != null
        || !['local', 's3'].includes(manifest.metadata.destination_type)) {
      throw new Error('Invalid standalone backup metadata');
    }
    return;
  }
  if (!['full', 'files'].includes(options.restoreType)) return;
  // Old full-copy and rsync runs were also labelled incremental. Without a
  // standalone marker their file completeness cannot be inferred from that
  // label or from settings re-read after the copy. Do not call a partial
  // recovery complete, even when force is requested.
  const settings = manifest?.metadata?.backup_settings;
  const incrementalSetting = settings?.backup_incremental;
  const incrementalEnabled = typeof incrementalSetting === 'string'
    ? incrementalSetting.trim().toLowerCase() !== 'false' && Boolean(incrementalSetting)
    : Boolean(incrementalSetting);
  // A local destination was one mirror, so a run labelled full catalogued
  // every file even with the incremental setting on. Each S3 run had its own
  // prefix, where that setting left the unchanged files in older prefixes.
  const legacyDelta = manifest.backup?.type === 'incremental'
    || (incrementalEnabled && manifest.metadata?.destination_type !== 'local');
  if (legacyDelta && manifest.metadata?.destination_type !== 'rsync') {
    throw new Error('This legacy incremental backup only lists the files that changed since its parent run, so it cannot prove a complete file set. '
      + 'Restore a legacy full backup or a standalone restore point, or use database-only or selective file recovery.');
  }
}

function contained(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep)
    && !path.isAbsolute(relative));
}

// extraRoots is for server-side callers only (the install-from-backup boot
// hook reads BACKUP_ROOT, which a fresh install's settings do not name).
async function assertLocalBackupRoot(candidate, config, extraRoots = []) {
  if (typeof candidate !== 'string' || !path.isAbsolute(candidate) || hasControlCharacters(candidate)) {
    throw new Error('Invalid local backup restore-point path');
  }
  const configured = [config?.backup_destination_path, config?.backup_manifest_path,
    ...(process.env.RESTORE_ALLOWED_ROOTS || '').split(path.delimiter), ...extraRoots]
    .filter(value => typeof value === 'string' && value.trim()).map(value => path.resolve(value));
  const resolved = path.resolve(candidate);
  if (!configured.some(root => contained(root, resolved))) {
    throw new Error('Selected backup root is outside configured backup locations');
  }
  const real = await fs.realpath(resolved);
  const realRoots = await Promise.all(configured.map(root => fs.realpath(root).catch(() => null)));
  if (!realRoots.some(root => root && contained(root, real))) {
    throw new Error('Selected backup root escapes configured locations through a symbolic link');
  }
  if (!(await fs.stat(real)).isDirectory()) throw new Error('Backup restore point is not a directory');
  return real;
}

function parseS3Location(value) {
  const match = typeof value === 'string' && value.match(/^s3:\/\/([^/]+)\/(.+)$/);
  if (!match || hasControlCharacters(value)
      || match[2].split('/').some(part => part === '.' || part === '..')) {
    throw new Error('Invalid S3 backup restore-point location');
  }
  return { bucket: match[1], prefix: match[2].replace(/\/$/, '') };
}

async function resolveBackupPointLocation(manifest, options, config) {
  const source = options.source;
  const extraRoots = Array.isArray(options.allowedRoots) ? options.allowedRoots : [];
  if (source === 's3') {
    const selected = parseS3Location(options.manifestPath);
    const directory = path.posix.dirname(selected.prefix);
    if (path.posix.basename(directory) !== 'manifests') {
      throw new Error('The selected S3 manifest does not identify its restore-point prefix');
    }
    const location = `s3://${selected.bucket}/${path.posix.dirname(directory)}`;
    parseS3Location(location);
    return location;
  }
  if (typeof source === 'string' && source.startsWith('s3://')) {
    parseS3Location(source);
    return source.replace(/\/$/, '');
  }
  if (source !== 'local') {
    // Existing explicit-path callers already pass the route's configured
    // root gate. Newly introduced standalone roots also get a realpath gate.
    return isStandaloneRestorePoint(manifest)
      ? assertLocalBackupRoot(typeof source === 'string' ? path.resolve(source) : source, config, extraRoots) : source;
  }
  if (!isStandaloneRestorePoint(manifest)) {
    const configuredRoot = config?.backup_destination_path;
    return assertLocalBackupRoot(typeof configuredRoot === 'string' ? path.resolve(configuredRoot) : configuredRoot, config, extraRoots);
  }
  const recorded = manifest.backup?.path;
  if (typeof recorded !== 'string' || !path.isAbsolute(recorded) || hasControlCharacters(recorded)) {
    throw new Error('Invalid local backup restore-point path');
  }
  // Default layouts and the ZIP's manifest.json alias travel with their
  // bytes. A rescued mount/extracted archive may be renamed without changing
  // its keyed manifest. Every physical root still needs the independent
  // configured-location + realpath gate; recorded paths never add trust.
  if (typeof options.manifestPath === 'string') {
    const directory = path.dirname(path.resolve(options.manifestPath));
    if (path.basename(options.manifestPath) === 'manifest.json') {
      return assertLocalBackupRoot(directory, config, extraRoots);
    }
    const sibling = path.dirname(directory);
    if (path.basename(directory) === 'manifests'
        && (manifest.metadata.restore_point_manifest_layout === 'nested'
          || path.basename(sibling) === path.basename(recorded))) {
      return assertLocalBackupRoot(sibling, config, extraRoots);
    }
  }
  return assertLocalBackupRoot(recorded, config, extraRoots);
}

function parseRunStatistics(run) {
  if (run?.statistics && typeof run.statistics === 'object') return run.statistics;
  try {
    return JSON.parse(run?.statistics) || {};
  } catch {
    return {};
  }
}

// The standalone snapshot a backup run wrote under the configured
// destination, or null for legacy runs and anything outside it. Nothing here
// touches storage; the removers below re-check what they are handed.
function standaloneSnapshotOfRun(config, run) {
  const manifestPath = typeof run?.manifest_path === 'string' ? run.manifest_path.trim() : '';
  if (!manifestPath) return null;
  if (manifestPath.startsWith('s3://')) {
    const match = manifestPath.match(/^s3:\/\/([^/]+)\/(.+)\/manifests\/[^/]+$/);
    // The same normalisation performS3Backup applies when it builds the key.
    const base = path.posix.join(config?.backup_s3_prefix ? String(config.backup_s3_prefix) : 'backups', '/');
    if (!match || match[1] !== config?.backup_s3_bucket || base === '/' || !match[2].startsWith(base)
        || match[2].split('/').some(part => part === '.' || part === '..')
        || !STANDALONE_SNAPSHOT_RE.test(path.posix.basename(match[2]))) {
      return null;
    }
    return { type: 's3', bucket: match[1], prefix: match[2] };
  }
  const destinationRoot = path.resolve(config?.backup_destination_path || path.join(getStoragePath(), 'backups'));
  const manifestFile = path.resolve(manifestPath);
  const manifestDir = path.dirname(manifestFile);
  // A manifest kept in backup_manifest_path does not sit in its snapshot, so
  // the run records where that is.
  const external = Boolean(config?.backup_manifest_path) && manifestDir === path.resolve(config.backup_manifest_path);
  const recorded = external ? parseRunStatistics(run).snapshot_path : path.dirname(manifestDir);
  if (typeof recorded !== 'string' || (!external && path.basename(manifestDir) !== 'manifests')) return null;
  const root = path.resolve(recorded);
  if (path.dirname(root) !== destinationRoot || !STANDALONE_SNAPSHOT_RE.test(path.basename(root))) return null;
  return { type: 'local', root, destinationRoot, manifestFile: external ? manifestFile : null };
}

// Remove one whole local snapshot: a real backup-<uuid> directory directly
// inside the destination, never a symlink to somewhere else. False when it
// is already gone.
async function removeLocalSnapshot(destinationRoot, root) {
  const resolved = path.resolve(root);
  if (path.dirname(resolved) !== path.resolve(destinationRoot) || !STANDALONE_SNAPSHOT_RE.test(path.basename(resolved))) {
    throw new Error('Refusing to remove a path that is not a standalone backup snapshot');
  }
  let realSnapshot;
  try {
    realSnapshot = await fs.realpath(resolved);
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
  if (realSnapshot !== path.join(await fs.realpath(destinationRoot), path.basename(resolved))) {
    throw new Error('The backup snapshot escapes its configured directory');
  }
  await fs.rm(realSnapshot, { recursive: true, force: true });
  return true;
}

// Remove every object of one S3 snapshot prefix. Returns how many went.
async function removeS3Snapshot(adapter, prefix) {
  const snapshotPrefix = String(prefix || '').replace(/\/+$/, '');
  if (!STANDALONE_SNAPSHOT_RE.test(path.posix.basename(snapshotPrefix))) {
    throw new Error('Refusing to remove a prefix that is not a standalone backup snapshot');
  }
  const listPrefix = `${snapshotPrefix}/`;
  const keys = [];
  let continuationToken;
  do {
    const page = await adapter.list(listPrefix, { maxKeys: 1000, continuationToken });
    for (const object of page.Contents || []) {
      if (typeof object.Key === 'string' && object.Key.startsWith(listPrefix)) keys.push(object.Key);
    }
    continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (continuationToken);
  if (keys.length === 0) return 0;
  const result = await adapter.deleteMany(keys);
  const errors = result.Errors || [];
  if (errors.length > 0) {
    throw new Error(`${errors.length} of ${keys.length} objects could not be deleted`);
  }
  return keys.length;
}

module.exports = {
  STANDALONE_SNAPSHOT_RE,
  isStandaloneRestorePoint, assertCompleteFileRestore,
  assertLocalBackupRoot, parseS3Location, resolveBackupPointLocation,
  standaloneSnapshotOfRun, removeLocalSnapshot, removeS3Snapshot,
};
