'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { getStoragePath } = require('../config/storage');
const { AppError } = require('../utils/errors');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const LOCAL_FILESYSTEMS = new Set([0xef53n, 0x58465342n, 0x9123683en, 0x01021994n, 0x794c7630n, 0x2fc12fc1n]);
function unsafe(message) { return Object.assign(new Error(message), { code: 'RESTORE_STORAGE_UNSAFE', statusCode: 503 }); }
async function hostIdentity() {
  if (process.platform !== 'linux') throw unsafe('Coordinated restore requires Linux and a shared supported local storage mount');
  let machine = process.env.MEDIA_PROCESS_HOST_ID;
  if (!machine) for (const filename of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
    try { machine = (await fsp.readFile(filename, 'utf8')).trim(); if (machine) break; } catch (_) { /* No fabricated hostname fallback. */ }
  }
  if (machine && (typeof machine !== 'string' || !/^[a-zA-Z0-9_-]{16,256}$/.test(machine))) throw unsafe('Configured local host identity is invalid');
  const bootId = (await fsp.readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
  if (!UUID.test(bootId)) throw unsafe('Kernel boot identity is unavailable');
  return { host: machine ? crypto.createHash('sha256').update(machine).digest('hex') : null, bootId };
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
  if (!stat.isDirectory() || !LOCAL_FILESYSTEMS.has(filesystem)) throw unsafe('Restore requires a supported local persistent filesystem');
  const device = String(stat.dev);
  const privateRoot = path.join(root, '.picpeak-maintenance');
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
function sameRuntimeVolume(storage, registration) {
  const current = storage.identity;
  if (registration.storage_id !== storage.storageId || !UUID.test(registration.boot_id)
    || (registration.host_id && current.host && registration.host_id !== current.host)) return false;
  return registration.boot_id === current.bootId || !!(registration.host_id && current.host && registration.host_id === current.host);
}

module.exports = { storageIdentity, attemptDirectory, hostIdentity, sameRuntimeVolume, syncDirectory };
