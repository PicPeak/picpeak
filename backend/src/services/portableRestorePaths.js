'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { getStoragePath } = require('../config/storage');
const { AppError } = require('../utils/errors');
const { isLocalFilesystem } = require('./portableRestoreCapability');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAINTENANCE = '.picpeak-maintenance';
// How long the undo copies of a COMMITTED restore are kept before the next
// boot or restore removes them (docs/PORTABLE_RESTORE.md).
const UNDO_RETENTION_MS = 24 * 60 * 60 * 1000;
function unsafe(message) { return Object.assign(new Error(message), { code: 'RESTORE_STORAGE_UNSAFE', statusCode: 503 }); }
// Only reached where portableRestoreCapability says the host qualifies. The
// host id is the one the media layer persists under the data directory, so it
// survives a reboot and a recreated container.
async function hostIdentity() {
  if (process.platform !== 'linux') throw unsafe('Coordinated restore requires Linux and a shared supported local storage mount');
  const { host } = await require('./linuxProcessLease').hostIdentity();
  const bootId = (await fsp.readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
  if (!UUID.test(bootId)) throw unsafe('Kernel boot identity is unavailable');
  return { host: typeof host === 'string' && /^[a-f0-9]{16,64}$/.test(host) ? host : null, bootId };
}
async function privateDirectory(directory, { create = false, device } = {}) {
  let created = false;
  if (create) {
    try { await fsp.mkdir(directory, { mode: 0o700 }); created = true; } catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  const stat = await fsp.lstat(directory, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== BigInt(process.getuid())
    || (stat.mode & 0o077n) !== 0n || (device && String(stat.dev) !== device)
    || await fsp.realpath(directory) !== directory) throw unsafe('Restore directory is not private on the authoritative volume');
  if (created) await syncDirectory(path.dirname(directory));
  return stat;
}
async function syncDirectory(directory) {
  const handle = await fsp.open(directory, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}
async function storageIdentity({ create = false } = {}) {
  const identity = await hostIdentity();
  // This control bootstrap intentionally precedes ordinary DB startup, which
  // used to create the configured storage root on a fresh native install.
  if (create) await fsp.mkdir(getStoragePath(), { recursive: true, mode: 0o700 });
  const root = await fsp.realpath(getStoragePath());
  const stat = await fsp.stat(root, { bigint: true });
  let measurement;
  try { measurement = await fsp.statfs(root, { bigint: true }); }
  catch (_) { throw new AppError('Restore capacity measurement is unavailable', 507, 'RESTORE_CAPACITY_UNKNOWN'); }
  if (typeof measurement?.type !== 'bigint') throw new AppError('Restore capacity measurement is unavailable', 507, 'RESTORE_CAPACITY_UNKNOWN');
  const filesystem = measurement.type;
  if (!stat.isDirectory() || !isLocalFilesystem(filesystem)) throw unsafe('Restore requires a supported local persistent filesystem');
  const device = String(stat.dev);
  const privateRoot = path.join(root, MAINTENANCE);
  await privateDirectory(privateRoot, { create, device });
  const marker = path.join(privateRoot, 'storage-id');
  if (create) {
    // Publish a fully fsynced immutable marker atomically. Another first-boot
    // replica must never adopt an empty in-progress O_EXCL write as its ID.
    const candidate = path.join(privateRoot, `.storage-id-${crypto.randomUUID()}.tmp`);
    let handle;
    try {
      handle = await fsp.open(candidate, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      await handle.writeFile(crypto.randomUUID()); await handle.sync();
      await handle.close(); handle = null;
      try { await fsp.link(candidate, marker); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    } finally {
      await handle?.close();
      await fsp.unlink(candidate).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
    await syncDirectory(privateRoot);
  }
  let read;
  for (let attempt = 0; attempt < 20; attempt++) {
    read = await fsp.open(marker, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    // Atomic link publication can briefly retain the writer's temporary link.
    // Wait only for positive single-link validation, never accept an unknown
    // marker or interpret a delay as runtime/worker death.
    if (create && (await read.stat()).nlink === 2 && attempt < 19) {
      await read.close();
      await new Promise(resolve => setTimeout(resolve, 5));
      continue;
    }
    break;
  }
  let storageId;
  try {
    const markerStat = await read.stat();
    if (!markerStat.isFile() || markerStat.nlink !== 1 || markerStat.uid !== process.getuid()
      || (markerStat.mode & 0o077) !== 0 || markerStat.size !== 36 || String(markerStat.dev) !== device) throw unsafe('Restore storage marker is invalid');
    storageId = await read.readFile('utf8');
    if (!UUID.test(storageId)) throw unsafe('Restore storage marker is invalid');
  } finally { await read.close(); }
  await privateDirectory(path.join(privateRoot, 'runtime'), { create, device });
  return { root, privateRoot, storageId, device, filesystem: String(filesystem), identity };
}
async function attemptDirectory(attemptId, { create = false } = {}) {
  if (!UUID.test(attemptId)) throw unsafe('Restore attempt ID is invalid');
  const storage = await storageIdentity({ create });
  const directory = path.join(storage.privateRoot, attemptId);
  await privateDirectory(directory, { create, device: storage.device });
  if (create) {
    for (const name of await fsp.readdir(directory)) {
      if (!['worker.lease', 'request.json', 'request.picpeak', 'workspace'].includes(name)) throw unsafe('Restore attempt already contains a journal');
      const entry = await fsp.lstat(path.join(directory, name));
      if (entry.isSymbolicLink() || entry.uid !== process.getuid() || (entry.mode & 0o077) !== 0
        || String(entry.dev) !== storage.device
        || (name === 'workspace' ? !entry.isDirectory() : (!entry.isFile() || entry.nlink !== 1))) throw unsafe('Restore attempt entry is unsafe');
    }
    await syncDirectory(storage.privateRoot);
  }
  return directory;
}
// A registration's kernel lease can be probed only by a process that could
// share it: the same boot, or the same host after a reboot (where every flock
// of the earlier boot is gone). Anything else is decided by its heartbeat.
function leaseProvable(storage, registration) {
  const current = storage.identity;
  if (registration.storage_id !== storage.storageId || !UUID.test(registration.boot_id || '')) return false;
  return registration.boot_id === current.bootId || !!(registration.host_id && current.host && registration.host_id === current.host);
}

// The fence marker lets a runtime notice a restore without a database query:
// one small file, absent on an install that never ran a portable restore.
const fencePath = () => path.join(getStoragePath(), MAINTENANCE, 'fence.json');
async function readFence() {
  try {
    const text = await fsp.readFile(fencePath(), 'utf8');
    if (text.length > 512) return null;
    const value = JSON.parse(text);
    if (!value || typeof value.fenced !== 'boolean' || !Number.isSafeInteger(value.generation) || value.generation < 0) return null;
    return { fenced: value.fenced, generation: value.generation, since: Number.isFinite(value.since) ? value.since : 0 };
  } catch (_) { return null; }
}
async function writeFence({ fenced, generation }) {
  const file = fencePath();
  const temporary = `${file}.${crypto.randomUUID()}.next`;
  const handle = await fsp.open(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(JSON.stringify({ version: 1, fenced, generation, since: Date.now() })); await handle.sync(); }
  finally { await handle.close(); }
  await fsp.rename(temporary, file);
  await syncDirectory(path.dirname(file));
}

async function removeTree(target) {
  await fsp.rm(target, { recursive: true, force: true });
}
// After a verified rollback nothing of the attempt is needed. After a commit
// the extracted workspace, the archive copy and the staged files go at once;
// only the undo copies stay, for UNDO_RETENTION_MS.
async function cleanAttempt(attemptId, { committed }) {
  if (!UUID.test(attemptId || '')) return;
  const directory = path.join(await fsp.realpath(getStoragePath()), MAINTENANCE, attemptId);
  if (!committed) { await removeTree(directory); return; }
  for (const name of ['workspace', 'request.picpeak', 'new']) await removeTree(path.join(directory, name));
}
// Leftovers of earlier attempts and interrupted uploads. `current` is the
// attempt the control row still names; it is only touched once it is terminal.
async function reapLeftovers({ current = null, currentTerminal = true, now = Date.now() } = {}) {
  let root;
  try { root = path.join(await fsp.realpath(getStoragePath()), MAINTENANCE); await fsp.lstat(root); } catch (_) { return 0; }
  let removed = 0;
  for (const entry of await fsp.readdir(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    try {
      if (entry.name === 'uploads' && currentTerminal) {
        for (const name of await fsp.readdir(target)) { await removeTree(path.join(target, name)); removed += 1; }
      } else if (entry.isFile() && /\.next$/.test(entry.name)) {
        if (now - (await fsp.lstat(target)).mtimeMs > 60 * 1000) { await fsp.unlink(target); removed += 1; }
      } else if (entry.isDirectory() && UUID.test(entry.name)) {
        if (entry.name === current && !currentTerminal) continue;
        const age = now - (await fsp.lstat(target)).mtimeMs;
        const undo = await fsp.lstat(path.join(target, 'undo')).catch(() => null);
        if (entry.name === current && undo && age <= UNDO_RETENTION_MS) {
          for (const name of ['workspace', 'request.picpeak', 'new']) await removeTree(path.join(target, name));
          continue;
        }
        await removeTree(target); removed += 1;
      }
    } catch (_) { /* Best effort: a leftover is disk use, never a reason to stay closed. */ }
  }
  return removed;
}

module.exports = { storageIdentity, attemptDirectory, hostIdentity, leaseProvable, syncDirectory,
  readFence, writeFence, fencePath, cleanAttempt, reapLeftovers, MAINTENANCE, UNDO_RETENTION_MS };
