'use strict';

const fsp = require('fs').promises;
const path = require('path');
const { getStoragePath } = require('../config/storage');

// Coordinated portable restore is OPTIONAL. It needs Linux, the compiled
// kernel-lease addon, the media process guard (which hands the restore worker
// its lease) and storage on a local filesystem. Where any of those is
// missing the application starts and runs exactly as it does without this
// feature; only the .picpeak import answers 503 with the reason below.

// ext2/3/4, xfs, btrfs, tmpfs, overlayfs, zfs, f2fs. Network filesystems do
// not give the flock/rename/fsync guarantees the restore journal relies on.
const LOCAL_FILESYSTEMS = new Set([0xef53n, 0x58465342n, 0x9123683en, 0x01021994n, 0x794c7630n, 0x2fc12fc1n, 0xf2f52010n]);
function isLocalFilesystem(type) {
  try { return LOCAL_FILESYSTEMS.has(BigInt.asUintN(32, BigInt(type))); } catch (_) { return false; }
}

const REASONS = Object.freeze({
  RESTORE_UNSUPPORTED_PLATFORM: 'Portable restore needs a Linux host (Docker images qualify)',
  RESTORE_LEASE_UNAVAILABLE: 'Portable restore needs the compiled kernel-lease addon (cd backend && npm run build:native)',
  RESTORE_GUARD_UNAVAILABLE: 'Portable restore needs the media process guard (bin/media-process-guard, ptrace allowed for the container)',
  RESTORE_STORAGE_UNSUPPORTED: 'Portable restore needs STORAGE_PATH on a local filesystem (ext4, xfs, btrfs, zfs, f2fs, tmpfs or overlay)',
});
const off = reason => Object.freeze({ available: false, reason, message: REASONS[reason] });

// The storage root may not exist yet on a first boot; its nearest existing
// ancestor is on the filesystem it will be created on.
async function storageFilesystem(directory = getStoragePath()) {
  let current = path.resolve(directory);
  for (;;) {
    try { return (await fsp.statfs(current, { bigint: true })).type; }
    catch (error) {
      const parent = path.dirname(current);
      if (error.code !== 'ENOENT' || parent === current) throw error;
      current = parent;
    }
  }
}

async function detectStatic() {
  try {
    if (process.platform !== 'linux') return off('RESTORE_UNSUPPORTED_PLATFORM');
    try { require('./mediaCapabilities').loadAddon(); } catch (_) { return off('RESTORE_LEASE_UNAVAILABLE'); }
    if (!isLocalFilesystem(await storageFilesystem())) return off('RESTORE_STORAGE_UNSUPPORTED');
    return null;
  } catch (_) {
    // An unreadable storage root is not a reason to refuse to start.
    return off('RESTORE_STORAGE_UNSUPPORTED');
  }
}

let cached;
// Platform, addon and filesystem are probed once per process. The guard is
// read from the media layer's own one-time probe each time, because that
// layer can switch it off later. Never throws.
async function probe() {
  cached ||= detectStatic();
  const refused = await cached;
  if (refused) return refused;
  try {
    if (!(await require('./mediaCapabilities').probe()).guard) return off('RESTORE_GUARD_UNAVAILABLE');
  } catch (_) { return off('RESTORE_GUARD_UNAVAILABLE'); }
  return AVAILABLE;
}
const AVAILABLE = Object.freeze({ available: true, reason: null, message: null });

module.exports = { probe, isLocalFilesystem, REASONS,
  // Tests only.
  reset: () => { cached = undefined; } };
