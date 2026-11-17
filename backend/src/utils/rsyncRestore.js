'use strict';

// Restore straight from an rsync destination: fetch the signed manifests a
// backup run copied to <backup_rsync_path>/manifests/ (uploadRsyncManifest),
// and the dump and files one restore point needs, into a private staging
// directory. Everything goes over the vetted connection a backup run uses
// (resolveRsyncConnection), never a second SSH path. Nothing fetched here is
// trusted: the restore authenticates the manifest and checks every file
// against it, exactly as for a local restore point.

const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const yaml = require('js-yaml');
const rsyncConnection = require('./rsyncConnection');
const { RSYNC_MIRROR_LAYOUT } = require('./backupRestorePoint');

const RSYNC_MANIFEST_DIR = 'manifests';
const REMOTE_REF_PREFIX = `rsync:${RSYNC_MANIFEST_DIR}/`;
const REMOTE_MANIFEST_NAME_RE = /^backup-manifest-[A-Za-z0-9][A-Za-z0-9._-]{0,200}\.(?:json|ya?ml)$/;
// The restore reads a manifest whole into memory (restoreService MAX_MANIFEST_BYTES).
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
// rsync --timeout: a stalled transfer fails instead of hanging the restore.
const IO_TIMEOUT_SECONDS = 300;

class RestoreRemoteError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.code = code;
  }
}

const isRemoteManifestRef = value => typeof value === 'string' && value.startsWith(REMOTE_REF_PREFIX);

function remoteManifestRef(name) {
  if (!REMOTE_MANIFEST_NAME_RE.test(name)) throw new Error('Invalid remote manifest name');
  return REMOTE_REF_PREFIX + name;
}

/** The manifest file name a `rsync:manifests/<name>` reference names. */
function parseRemoteManifestRef(value) {
  const name = isRemoteManifestRef(value) ? value.slice(REMOTE_REF_PREFIX.length) : '';
  if (!REMOTE_MANIFEST_NAME_RE.test(name)) {
    throw new RestoreRemoteError('RESTORE_REMOTE_MANIFEST_INVALID',
      'An rsync restore point is named rsync:manifests/backup-manifest-<id>.json');
  }
  return name;
}

/** A manifest a backup run wrote for its rsync mirror and copied beside it. */
function isRemoteMirrorManifest(manifest) {
  return manifest?.metadata?.destination_type === 'rsync'
    && manifest.metadata.rsync_manifest_layout === RSYNC_MIRROR_LAYOUT
    && manifest.metadata.restore_point == null;
}

/**
 * A path from a manifest, relative to the mirror root: no absolute path, no
 * empty, `.` or `..` segment, no control character. It is handed to rsync
 * (--files-from) and joined under the staging root.
 */
function assertMirrorRelativePath(value, label) {
  // eslint-disable-next-line no-control-regex
  if (typeof value !== 'string' || !value || value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value)
      || value.startsWith('/') || path.isAbsolute(value)
      || value.split('/').some(part => part === '' || part === '.' || part === '..')) {
    throw new RestoreRemoteError('RESTORE_REMOTE_PATH_UNSAFE',
      `Refusing ${label} ${JSON.stringify(String(value).slice(0, 200))}: not a plain path inside the rsync mirror`);
  }
  return value;
}

async function connectRemote(config) {
  if (!config?.backup_rsync_host || !config.backup_rsync_path) {
    throw new RestoreRemoteError('RSYNC_CONFIG_INVALID',
      'No rsync destination (host and remote path) is configured to restore from');
  }
  // The same parameter check and connection a backup run uses.
  const { validateRsyncParam } = require('../services/backupService');
  let remotePath;
  try {
    remotePath = validateRsyncParam(config.backup_rsync_path, 'remote path');
  } catch (error) {
    throw new RestoreRemoteError('RSYNC_CONFIG_INVALID', error.message);
  }
  const connection = await rsyncConnection.resolveRsyncConnection({ host: config.backup_rsync_host,
    user: config.backup_rsync_user, sshKey: config.backup_rsync_ssh_key, port: config.backup_rsync_port });
  // "<base>/x": "/" stays the root, a relative path stays relative.
  const base = remotePath.replace(/\/+$/, '');
  return { connection, remotePath, base: base || (remotePath.startsWith('/') ? '' : '.') };
}

function failure(outcome, remote, notFound) {
  const stderr = String(outcome.stderr || '');
  if (!outcome.error && notFound && rsyncConnection.PATH_NOT_FOUND.test(stderr)) {
    return new RestoreRemoteError(notFound.code, notFound.message);
  }
  return rsyncConnection.rsyncProbeFailure(outcome, remote.connection, { remotePath: remote.remotePath });
}

const transferArgs = remote => ['--times', `--timeout=${IO_TIMEOUT_SECONDS}`, '-e', remote.connection.rsyncShell];

// A destination is untrusted: listing its manifests downloads at most this
// many (the newest) and this many bytes in all, whatever it holds.
const MAX_LISTED_MANIFESTS = 20;
const MAX_LISTED_MANIFEST_BYTES = 64 * 1024 * 1024;
// `rsync --list-only` line: mode, size (digit groups), date, time, name.
const LIST_LINE_RE = /^([-dlcbps])[-rwxsStT]{9}\S*\s+([\d,.]+)\s+(\d{4}\/\d{2}\/\d{2})\s+(\d{2}:\d{2}:\d{2})\s+(.+)$/;

const manifestsNotFound = remoteDir => ({
  code: 'RESTORE_REMOTE_MANIFEST_NOT_FOUND',
  message: `The rsync destination has no ${remoteDir}/ directory. Backups made before the manifest was copied to the destination cannot be restored from it directly; copy the mirror back by hand.`,
});

/**
 * List <backup_rsync_path>/manifests/ without downloading anything and pick
 * what may be fetched: regular files with a strict backup-manifest name of at
 * most MAX_MANIFEST_BYTES, the newest MAX_LISTED_MANIFESTS of them, within
 * MAX_LISTED_MANIFEST_BYTES together.
 */
async function selectRemoteManifests(remote) {
  const remoteDir = `${remote.base}/${RSYNC_MANIFEST_DIR}`;
  let newest = [];
  const outcome = await rsyncConnection.runRsync(['--list-only', `--timeout=${IO_TIMEOUT_SECONDS}`,
    '-e', remote.connection.rsyncShell, `${remote.connection.rsyncTarget}:${remoteDir}/`], {
    timeoutMs: 0,
    onStdoutLine: (line) => {
      const match = LIST_LINE_RE.exec(line);
      if (!match || match[1] !== '-' || !REMOTE_MANIFEST_NAME_RE.test(match[5])) return;
      const size = Number(match[2].replace(/[,.]/g, ''));
      if (!Number.isSafeInteger(size) || size > MAX_MANIFEST_BYTES) return;
      newest.push({ name: match[5], size, stamp: `${match[3]} ${match[4]}` });
      if (newest.length > MAX_LISTED_MANIFESTS * 2) {
        newest = newest.sort(byNewest).slice(0, MAX_LISTED_MANIFESTS);
      }
    },
  });
  if (outcome.code !== 0) throw failure(outcome, remote, manifestsNotFound(remoteDir));
  const selected = [];
  let total = 0;
  for (const entry of newest.sort(byNewest).slice(0, MAX_LISTED_MANIFESTS)) {
    if (total + entry.size > MAX_LISTED_MANIFEST_BYTES) break;
    total += entry.size;
    selected.push(entry);
  }
  return selected;
}

const byNewest = (a, b) => (a.stamp === b.stamp ? b.name.localeCompare(a.name) : b.stamp.localeCompare(a.stamp));

/**
 * Download manifests from <backup_rsync_path>/manifests/ into `dir`: the one
 * named, or the bounded selection of selectRemoteManifests. They go through
 * fetchRemoteFiles, so each is size-capped, the transfer has a byte budget
 * and no symlink is followed or recreated. Returns `{ name, path }` each.
 */
async function fetchRemoteManifests(config, dir, { name } = {}) {
  if (name !== undefined) parseRemoteManifestRef(REMOTE_REF_PREFIX + name);
  const remote = await connectRemote(config);
  const remoteDir = `${remote.base}/${RSYNC_MANIFEST_DIR}`;
  const entries = name ? [{ name, size: MAX_MANIFEST_BYTES }] : await selectRemoteManifests(remote);
  if (entries.length === 0) return [];
  const root = path.join(dir, 'fetched');
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const rels = entries.map(entry => `${RSYNC_MANIFEST_DIR}/${entry.name}`);
  try {
    await module.exports.fetchRemoteFiles(config, rels, root, {
      maxSize: MAX_MANIFEST_BYTES,
      budgetBytes: entries.reduce((total, entry) => total + entry.size, 0) + 1024 * 1024,
    });
  } catch (error) {
    if (error.code === 'RESTORE_REMOTE_FILE_MISSING') {
      throw new RestoreRemoteError('RESTORE_REMOTE_MANIFEST_NOT_FOUND', name
        ? `The rsync destination holds no ${remoteDir}/${name} (or not as a regular manifest file of at most ${MAX_MANIFEST_BYTES} bytes). Each backup run keeps only its own manifest there; list the restore points again.`
        : `Manifests listed in ${remoteDir}/ on the rsync destination disappeared while they were downloaded; list the restore points again.`);
    }
    throw error;
  }
  return entries.map(entry => ({ name: entry.name, path: path.join(root, RSYNC_MANIFEST_DIR, entry.name) }));
}

function parseManifestFile(raw, file) {
  const trimmed = raw.trimStart();
  return file.endsWith('.json') && (trimmed.startsWith('{') || trimmed.startsWith('['))
    ? JSON.parse(raw) : yaml.load(raw);
}

/**
 * Every mirror-v1 manifest on the rsync destination, each authenticated as a
 * restore would (signature, or a host-approved recovery digest). Other
 * manifests are left out; one that fails authentication is returned with
 * its error so the wizard can say so. The download directory is private and
 * removed before this returns.
 */
async function listRemoteManifests(config) {
  const backupManifest = require('../services/backupManifest');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'picpeak-rsync-manifests-'));
  try {
    await fs.chmod(dir, 0o700);
    const listed = [];
    for (const file of await fetchRemoteManifests(config, dir)) {
      let manifest;
      try {
        manifest = parseManifestFile(await fs.readFile(file.path, 'utf8'), file.name);
      } catch {
        continue;
      }
      if (!isRemoteMirrorManifest(manifest)) continue;
      const stats = await fs.stat(file.path);
      try {
        backupManifest.validateManifest(manifest, { allowRecovery: true });
        listed.push({ name: file.name, ref: remoteManifestRef(file.name), manifest, mtime: stats.mtime, error: null });
      } catch (error) {
        listed.push({ name: file.name, ref: remoteManifestRef(file.name), manifest, mtime: stats.mtime, error: error.message });
      }
    }
    return listed;
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/**
 * Refuse a download that does not fit: the sum of the manifest sizes against
 * the free space of the staging volume.
 */
async function assertStagingSpace(dir, requiredBytes, formatBytes = String, { restoredBytes = 0, storagePath } = {}) {
  const { bavail, bsize } = await fs.statfs(dir);
  const availableBytes = bavail * bsize;
  // Staging and the live storage on one volume: the downloaded copy and the
  // restored copy exist side by side until staging is removed.
  const shared = Boolean(storagePath) && restoredBytes > 0 && await module.exports.sameDevice(dir, storagePath);
  const needed = requiredBytes + (shared ? restoredBytes : 0);
  if (needed > availableBytes) {
    throw new RestoreRemoteError('RESTORE_INSUFFICIENT_SPACE',
      `Downloading this restore point from the rsync destination needs ${formatBytes(needed)} in ${dir}`
      + `${shared ? ` (the download plus the restored copy: the restore temp directory and ${storagePath} share one volume)` : ''}, `
      + `but only ${formatBytes(availableBytes)} are free there. Free up space on that volume (or point TMPDIR at a larger one) and retry.`);
  }
  return { requiredBytes: needed, availableBytes, shared };
}

// The device of `target`, or of its nearest existing parent (the storage
// root of a fresh install may not exist yet).
async function deviceOf(target) {
  let current = path.resolve(target);
  for (;;) {
    try {
      return (await fs.stat(current)).dev;
    } catch (error) {
      const parent = path.dirname(current);
      if (error.code !== 'ENOENT' || parent === current) throw error;
      current = parent;
    }
  }
}

async function sameDevice(a, b) {
  return (await deviceOf(a)) === (await deviceOf(b));
}

// Bytes under `dir` (rsync's temporary files included), never following links.
async function stagedBytes(dir) {
  let total = 0;
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += await stagedBytes(full);
    else total += (await fs.lstat(full).catch(() => ({ size: 0 }))).size;
  }
  return total;
}

/**
 * Download `relPaths` (validated, relative to the mirror root) from the rsync
 * destination into `root`, keeping their relative layout (--files-from).
 * `maxSize` bounds what rsync accepts per file. `budgetBytes` bounds what the
 * whole transfer may write: the staged bytes are watched while rsync runs,
 * and the run is stopped the moment they exceed it, so a destination that
 * sends more than the manifest records cannot fill the volume before any
 * checksum is compared. Every listed file must have arrived as a regular
 * file; missing ones are named in the error.
 */
async function fetchRemoteFiles(config, relPaths, root, { maxSize, budgetBytes, onProgress } = {}) {
  relPaths.forEach(rel => assertMirrorRelativePath(rel, 'manifest path'));
  const remote = await connectRemote(config);
  const listFile = path.join(path.dirname(root), 'files-from');
  await fs.writeFile(listFile, relPaths.join('\0'), { mode: 0o600 });
  let done = 0;
  const args = [...transferArgs(remote), '--from0', `--files-from=${listFile}`,
    ...(maxSize > 0 ? [`--max-size=${Math.ceil(maxSize)}`] : []), '--out-format=%n',
    `${remote.connection.rsyncTarget}:${remote.base}/`, `${root}/`];
  let outcome;
  const controller = new AbortController();
  const budgeted = Number.isFinite(budgetBytes) && budgetBytes >= 0;
  const before = budgeted ? await stagedBytes(root) : 0;
  let overBudget = false;
  const overBy = async () => budgeted && (await stagedBytes(root)) - before > budgetBytes;
  let polling = false;
  const watcher = budgeted ? setInterval(async () => {
    if (polling || overBudget) return;
    polling = true;
    try {
      if (await overBy()) { overBudget = true; controller.abort(); }
    } finally { polling = false; }
  }, module.exports.BUDGET_POLL_MS) : null;
  try {
    outcome = await rsyncConnection.runRsync(args, {
      timeoutMs: 0,
      signal: controller.signal,
      onStdoutLine: (line) => {
        if (!line || line.endsWith('/')) return;
        done += 1;
        if (onProgress) onProgress(Math.min(done, relPaths.length), relPaths.length);
      },
    });
  } finally {
    if (watcher) clearInterval(watcher);
    await fs.rm(listFile, { force: true });
  }
  if (overBudget || await overBy()) {
    throw new RestoreRemoteError('RESTORE_REMOTE_DOWNLOAD_TOO_LARGE',
      `The rsync destination sent more than the ${budgetBytes} bytes this restore point records for these files; download stopped`);
  }
  // 23/24: some files were not transferred or vanished; the check below names them.
  if (outcome.code !== 0 && !(outcome.code === 23 || outcome.code === 24)) {
    throw failure(outcome, remote);
  }
  const missing = [];
  for (const rel of relPaths) {
    const stats = await fs.lstat(path.join(root, rel)).catch(() => null);
    if (!stats || !stats.isFile()) missing.push(rel);
  }
  if (missing.length > 0) {
    throw new RestoreRemoteError('RESTORE_REMOTE_FILE_MISSING',
      `${missing.length} of ${relPaths.length} file(s) this restore point lists could not be downloaded from the rsync destination `
      + `(missing, not a regular file, or larger than recorded): ${missing.slice(0, 5).join(', ')}`);
  }
  if (outcome.code !== 0) throw failure(outcome, remote);
  return { files: relPaths.length };
}

/** rsync settings for a restore on a host whose database holds none yet. */
function rsyncConfigFromEnv(env = process.env) {
  if (!env.BACKUP_RSYNC_HOST || !env.BACKUP_RSYNC_PATH) return null;
  return {
    backup_rsync_host: env.BACKUP_RSYNC_HOST,
    backup_rsync_path: env.BACKUP_RSYNC_PATH,
    backup_rsync_user: env.BACKUP_RSYNC_USER || null,
    backup_rsync_port: env.BACKUP_RSYNC_PORT || null,
    backup_rsync_ssh_key: env.BACKUP_RSYNC_SSH_KEY || null,
  };
}

module.exports = {
  RestoreRemoteError, REMOTE_REF_PREFIX, MAX_MANIFEST_BYTES,
  isRemoteManifestRef, remoteManifestRef, parseRemoteManifestRef, isRemoteMirrorManifest,
  assertMirrorRelativePath, fetchRemoteManifests, listRemoteManifests, assertStagingSpace,
  fetchRemoteFiles, rsyncConfigFromEnv, sameDevice, MAX_LISTED_MANIFESTS, MAX_LISTED_MANIFEST_BYTES,
  // How often a download's staged bytes are measured against its budget.
  BUDGET_POLL_MS: 1000,
};
