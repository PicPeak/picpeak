'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');
const { AppError } = require('../utils/errors');
const restorePaths = require('./portableRestorePaths');

const MAX_ARCHIVE_BYTES = 5 * 1024 ** 3;
const RESERVE_BYTES = 256 * 1024 ** 2;
const RESERVE_INODES = 1024;
const CHUNK_BYTES = 64 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const LOCAL_FILESYSTEMS = new Set([0xef53n, 0x58465342n, 0x9123683en, 0x01021994n, 0x794c7630n, 0x2fc12fc1n]);
const error = (code, message, status = 503) => new AppError(message, status, code);
const invalid = () => error('RESTORE_ARCHIVE_INVALID', 'Restore archive is invalid or changed', 400);

function createIngress({ paths = restorePaths, leases, filesystem = fsp } = {}) {
  const context = new AsyncLocalStorage();
  let activeSlot;
  const leaseService = () => leases || require('./linuxKernelLease');
  function current() {
    const slot = context.getStore();
    if (!slot?.accepting) throw error('RESTORE_INGRESS_DENIED', 'Restore staging has no live ingress owner');
    return slot;
  }
  async function capacity(slot, bytes = 0, inodes = 0) {
    let stats;
    try { stats = await filesystem.statfs(slot.storage.privateRoot, { bigint: true }); }
    catch (_) { throw error('RESTORE_CAPACITY_UNKNOWN', 'Restore capacity is unavailable', 507); }
    if (!stats || typeof stats.type !== 'bigint') throw error('RESTORE_CAPACITY_UNKNOWN', 'Restore capacity is unavailable', 507);
    if (!LOCAL_FILESYSTEMS.has(stats.type) || String(stats.type) !== slot.storage.filesystem) {
      throw error('RESTORE_STORAGE_UNSAFE', 'Restore workspace filesystem changed');
    }
    if ([stats.bavail, stats.bsize, stats.ffree].some(value => typeof value !== 'bigint' || value < 0n)
      || stats.bsize === 0n || !Number.isSafeInteger(bytes) || bytes < 0) {
      throw error('RESTORE_CAPACITY_UNKNOWN', 'Restore capacity is unavailable', 507);
    }
    if (stats.bavail * stats.bsize < BigInt(RESERVE_BYTES + bytes)
      || stats.ffree < BigInt(RESERVE_INODES + inodes)) {
      throw error('RESTORE_CAPACITY_LIMIT', 'Insufficient private restore workspace capacity', 507);
    }
    const stat = await filesystem.stat(slot.storage.privateRoot, { bigint: true });
    if (String(stat.dev) !== slot.storage.device) throw error('RESTORE_STORAGE_UNSAFE', 'Restore workspace device changed');
  }
  function own(slot, run) {
    const promise = Promise.resolve().then(run);
    slot.operations.add(promise);
    promise.finally(() => slot.operations.delete(promise)).catch(() => {});
    return promise;
  }
  async function directory(slot, filename, exclusive = false) {
    let created = false;
    try { await filesystem.mkdir(filename, { mode: 0o700 }); created = true; }
    catch (failure) { if (failure.code !== 'EEXIST' || exclusive) throw failure; }
    const stat = await filesystem.lstat(filename, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== BigInt(process.getuid())
      || (stat.mode & 0o077n) !== 0n || String(stat.dev) !== slot.storage.device
      || await filesystem.realpath(filename) !== filename) throw error('RESTORE_STORAGE_UNSAFE', 'Restore staging directory is unsafe');
    if (created) await paths.syncDirectory(path.dirname(filename));
    return stat;
  }
  async function removeOwned(filename, expected, parent) {
    let stat;
    try { stat = await filesystem.lstat(filename, { bigint: true }); }
    catch (failure) { if (failure.code === 'ENOENT') return; throw failure; }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || stat.uid !== BigInt(process.getuid())
      || (stat.mode & 0o077n) !== 0n || stat.dev !== expected.dev || stat.ino !== expected.ino) {
      throw error('RESTORE_STORAGE_UNSAFE', 'Restore cleanup file identity changed');
    }
    await filesystem.unlink(filename); await paths.syncDirectory(parent);
  }
  async function finish(slot) {
    try {
      slot.accepting = false;
      for (const stream of slot.streams) stream.destroy(error('RESTORE_INGRESS_ENDED', 'Restore ingress ended'));
      // A close/abort never releases the slot while an accepted file operation
      // or its cleanup can still finish later. Only actual settled I/O does.
      while (slot.operations.size) await Promise.allSettled([...slot.operations]);
      for (const cleanup of slot.cleanup.values()) await cleanup();
      await slot.lease.release();
      slot.resolve();
      if (activeSlot === slot) activeSlot = null;
    } catch (failure) {
      // Unknown cleanup or native release stays owned/fenced, not expired.
      slot.reject(failure);
      throw failure;
    }
  }
  async function withIngress(run) {
    const previous = context.getStore();
    if (previous) {
      if (!previous.accepting) throw error('RESTORE_INGRESS_DENIED', 'Restore ingress lifetime ended');
      const storage = await paths.storageIdentity();
      if (['root', 'privateRoot', 'storageId', 'device', 'filesystem'].some(key => storage[key] !== previous.storage[key])) {
        throw error('RESTORE_STORAGE_UNSAFE', 'Restore ingress volume changed');
      }
      return run();
    }
    const storage = await paths.storageIdentity();
    const leasePath = path.join(storage.privateRoot, 'upload.lease');
    const lease = await leaseService().acquire(leasePath);
    const slot = { storage, lease, accepting: true, operations: new Set(), streams: new Set(), cleanup: new Map() };
    slot.terminal = new Promise((resolve, reject) => { slot.resolve = resolve; slot.reject = reject; });
    slot.terminal.catch(() => {});
    activeSlot = slot;
    try {
      const stat = await filesystem.lstat(leasePath, { bigint: true });
      if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== BigInt(process.getuid()) || stat.nlink !== 1n
        || (stat.mode & 0o077n) !== 0n || String(stat.dev) !== storage.device || lease.path !== leasePath
        || lease.device !== storage.device || lease.filesystem !== storage.filesystem || lease.inode !== String(stat.ino)) {
        throw error('RESTORE_STORAGE_UNSAFE', 'Restore ingress lease identity is unsafe');
      }
      await paths.syncDirectory(storage.privateRoot);
      await capacity(slot, 0, 2);
      return await context.run(slot, run);
    } finally { await finish(slot); }
  }
  async function openDestination(slot, filename) {
    const handle = await filesystem.open(filename, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    const stat = await handle.stat({ bigint: true });
    if (!stat.isFile() || stat.nlink !== 1n || stat.uid !== BigInt(process.getuid()) || (stat.mode & 0o077n) !== 0n
      || String(stat.dev) !== slot.storage.device) { await handle.close(); throw error('RESTORE_STORAGE_UNSAFE', 'Restore staging file is unsafe'); }
    return { handle, identity: stat };
  }
  async function write(handle, buffer) {
    let position = 0;
    while (position < buffer.length) {
      const result = await handle.write(buffer, position, buffer.length - position);
      if (!Number.isSafeInteger(result.bytesWritten) || result.bytesWritten <= 0) throw error('RESTORE_IO_FAILED', 'Restore staging write failed');
      position += result.bytesWritten;
    }
  }
  function storage() {
    // Capture the internally owned slot during parser construction. Network
    // EventEmitter callbacks must not depend on ambient request ALS context.
    const slot = current();
    return {
      _handleFile(_req, file, done) {
        if (!slot.accepting) return done(error('RESTORE_INGRESS_DENIED', 'Restore upload was not admitted'));
        const ignoreError = () => {};
        const abort = () => file.stream.destroy(error('RESTORE_UPLOAD_ABORTED', 'Restore upload was interrupted', 400));
        file.stream.on('error', ignoreError);
        _req.once('aborted', abort);
        if (_req.aborted) abort();
        slot.streams.add(file.stream);
        own(slot, async () => {
          const uploads = path.join(slot.storage.privateRoot, 'uploads');
          await directory(slot, uploads);
          const parent = path.join(uploads, crypto.randomUUID()); const parentIdentity = await directory(slot, parent, true);
          const filename = path.join(parent, 'archive.picpeak');
          let identity;
          slot.cleanup.set(filename, async () => {
            if (identity) await removeOwned(filename, identity, parent);
            const stat = await filesystem.lstat(parent, { bigint: true });
            if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== parentIdentity.dev || stat.ino !== parentIdentity.ino) {
              throw error('RESTORE_STORAGE_UNSAFE', 'Restore upload directory identity changed');
            }
            await filesystem.rmdir(parent); await paths.syncDirectory(uploads);
          });
          let handle; let bytes = 0;
          try {
            await capacity(slot, 0, 1);
            ({ handle, identity } = await openDestination(slot, filename));
            for await (const chunk of file.stream) {
              if (!Buffer.isBuffer(chunk) || chunk.length > MAX_ARCHIVE_BYTES - bytes) {
                throw error('RESTORE_ARCHIVE_LIMIT', 'Restore archive exceeds the 5GiB limit', 413);
              }
              // Keep each write and capacity decision bounded even if a
              // producer supplies a large Buffer rather than socket chunks.
              for (let offset = 0; offset < chunk.length; offset += CHUNK_BYTES) {
                const part = chunk.subarray(offset, offset + CHUNK_BYTES);
                await capacity(slot, part.length);
                await write(handle, part); bytes += part.length;
              }
            }
            if (!bytes || (await handle.stat({ bigint: true })).size !== BigInt(bytes)) throw invalid();
            await handle.sync(); await paths.syncDirectory(parent);
            return { path: filename, size: bytes, filename: 'archive.picpeak', destination: parent };
          } finally { await handle?.close(); }
        }).then(value => done(null, value), done).finally(() => {
          slot.streams.delete(file.stream); _req.removeListener('aborted', abort); file.stream.removeListener('error', ignoreError);
        }).catch(() => {});
      },
      _removeFile(_req, _file, done) {
        // The shared slot's finalizer owns cleanup after every parser and I/O
        // continuation is terminal. Never unlink a live upload on res.close.
        done(null);
      },
    };
  }
  async function copyArchive({ sourcePath, destinationPath }) {
    const slot = current();
    const parent = path.dirname(destinationPath);
    const parentStat = await filesystem.lstat(parent, { bigint: true });
    if (path.basename(destinationPath) !== 'request.picpeak' || path.dirname(parent) !== slot.storage.privateRoot
      || !UUID.test(path.basename(parent)) || await filesystem.realpath(parent) !== parent
      || !parentStat.isDirectory() || parentStat.isSymbolicLink() || parentStat.uid !== BigInt(process.getuid())
      || (parentStat.mode & 0o077n) !== 0n || String(parentStat.dev) !== slot.storage.device) throw error('RESTORE_STORAGE_UNSAFE', 'Restore copy is outside its private attempt');
    let retain = false;
    return own(slot, async () => {
      let source; let target;
      try {
        source = await filesystem.open(sourcePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        const initial = await source.stat({ bigint: true });
        if (!initial.isFile() || initial.nlink !== 1n || initial.size <= 0n) throw invalid();
        if (initial.size > BigInt(MAX_ARCHIVE_BYTES)) throw error('RESTORE_ARCHIVE_LIMIT', 'Restore archive exceeds the 5GiB limit', 413);
        const sourceBytes = Number(initial.size);
        await capacity(slot, sourceBytes, 1);
        const destination = await openDestination(slot, destinationPath);
        target = destination.handle;
        slot.cleanup.set(destinationPath, () => !retain ? removeOwned(destinationPath, destination.identity, parent) : undefined);
        const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
        let bytes = 0;
        for (;;) {
          // Explicit FileHandle I/O: no borrowed ReadStream _destroy can close
          // or recycle this descriptor while a subsequent stat/read is pending.
          const result = await source.read(buffer, 0, buffer.length, bytes);
          if (!result.bytesRead) break;
          if (!Number.isSafeInteger(result.bytesRead) || result.bytesRead < 0 || result.bytesRead > buffer.length
            || result.bytesRead > sourceBytes - bytes || result.bytesRead > MAX_ARCHIVE_BYTES - bytes) throw invalid();
          await capacity(slot, result.bytesRead);
          await write(target, buffer.subarray(0, result.bytesRead)); bytes += result.bytesRead;
        }
        const final = await source.stat({ bigint: true });
        const leaf = await filesystem.lstat(sourcePath, { bigint: true });
        const targetLeaf = await filesystem.lstat(destinationPath, { bigint: true });
        if (bytes !== sourceBytes || ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'nlink'].some(key => final[key] !== initial[key])
          || leaf.isSymbolicLink() || leaf.dev !== initial.dev || leaf.ino !== initial.ino || leaf.size !== initial.size
          || targetLeaf.isSymbolicLink() || targetLeaf.dev !== destination.identity.dev || targetLeaf.ino !== destination.identity.ino
          || targetLeaf.nlink !== 1n || targetLeaf.size !== BigInt(bytes)
          || (await target.stat({ bigint: true })).size !== BigInt(bytes)) throw invalid();
        await target.sync(); await paths.syncDirectory(parent);
        return { path: destinationPath, bytes, retain: () => { retain = true; } };
      } finally { await target?.close(); await source?.close(); }
    });
  }
  function validateRequestEnvelope(req) {
    if (!Array.isArray(req.rawHeaders) || req.rawHeaders.length > 128
      || req.rawHeaders.reduce((total, value) => total + Buffer.byteLength(value), 0) > 16 * 1024) {
      throw error('RESTORE_REQUEST_INVALID', 'Restore request headers exceed their bound', 400);
    }
    const length = req.get('content-length');
    if (length && (!/^\d{1,12}$/.test(length) || Number(length) > MAX_ARCHIVE_BYTES + 64 * 1024)) {
      throw error('RESTORE_ARCHIVE_LIMIT', 'Restore archive exceeds the 5GiB request limit', 413);
    }
    const type = req.get('content-type');
    if (typeof type !== 'string' || type.length > 256 || !/^multipart\/form-data\s*;/i.test(type)) {
      throw error('RESTORE_REQUEST_INVALID', 'A bounded multipart archive is required', 400);
    }
  }
  return { withIngress, storage, copyArchive, validateRequestEnvelope,
    // Worker pre-exec cannot race a still owned parser, copy or cleanup. This
    // is private local lifetime proof, never a request/header capability.
    drain: async () => { if (activeSlot) await activeSlot.terminal; } };
}

module.exports = { ...createIngress(), createIngress, MAX_ARCHIVE_BYTES, RESERVE_BYTES, RESERVE_INODES };
