const fs = require('fs').promises;
const path = require('path');

const STANDALONE_VERSION = 'standalone-v1';

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
  const legacyDelta = manifest.backup?.type === 'incremental'
    || incrementalEnabled;
  if (legacyDelta && manifest.metadata?.destination_type !== 'rsync') {
    throw new Error('This legacy backup cannot prove a complete file set. Take a new standalone backup, or use database-only or selective file recovery.');
  }
}

function contained(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep)
    && !path.isAbsolute(relative));
}

async function assertLocalBackupRoot(candidate, config) {
  if (typeof candidate !== 'string' || !path.isAbsolute(candidate) || hasControlCharacters(candidate)) {
    throw new Error('Invalid local backup restore-point path');
  }
  const configured = [config?.backup_destination_path, config?.backup_manifest_path,
    ...(process.env.RESTORE_ALLOWED_ROOTS || '').split(path.delimiter)]
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
      ? assertLocalBackupRoot(typeof source === 'string' ? path.resolve(source) : source, config) : source;
  }
  if (!isStandaloneRestorePoint(manifest)) {
    const configuredRoot = config?.backup_destination_path;
    return assertLocalBackupRoot(typeof configuredRoot === 'string' ? path.resolve(configuredRoot) : configuredRoot, config);
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
      return assertLocalBackupRoot(directory, config);
    }
    const sibling = path.dirname(directory);
    if (path.basename(directory) === 'manifests'
        && (manifest.metadata.restore_point_manifest_layout === 'nested'
          || path.basename(sibling) === path.basename(recorded))) {
      return assertLocalBackupRoot(sibling, config);
    }
  }
  return assertLocalBackupRoot(recorded, config);
}

module.exports = {
  isStandaloneRestorePoint, assertCompleteFileRestore,
  assertLocalBackupRoot, parseS3Location, resolveBackupPointLocation,
};
