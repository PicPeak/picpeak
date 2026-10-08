'use strict';

// This is the bounded archive boundary, not the restore transaction. The caller
// must run it inside the supervised restore worker and keep its workspace private.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { promisify } = require('util');
const { PassThrough, Readable, Transform } = require('stream');
const { pipeline } = require('stream');
const zlib = require('zlib');
const StreamZip = require('node-stream-zip');

const HARD_LIMITS = Object.freeze({
  entries: 100000,
  nameBytes: 1024,
  centralBytes: 16 * 1024 * 1024,
  expandedBytes: 32 * 1024 * 1024 * 1024,
  manifestBytes: 16 * 1024 * 1024,
  reserveBytes: 256 * 1024 * 1024,
  reserveInodes: 1024,
  measureInterval: 1024 * 1024,
});
// Network filesystems cannot establish the local durability/capacity contract.
const LOCAL_FILESYSTEMS = new Set([0xef53n, 0x58465342n, 0x9123683en, 0x01021994n,
  0x794c7630n, 0x2fc12fc1n, 0xf2f52010n]);
const openFd = promisify(fs.open);
const closeFd = promisify(fs.close);
const statFd = promisify(fs.fstat);
const facadeState = new WeakMap();

function refusal(message, statusCode = 400, code = 'PORTABLE_ARCHIVE_REFUSED') {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function tightened(name, ceiling) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return ceiling;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw refusal(`${name} must be a positive integer.`, 400);
  }
  return Math.min(value, ceiling);
}

function limits() {
  return {
    ...HARD_LIMITS,
    entries: tightened('PICPEAK_IMPORT_MAX_ENTRIES', HARD_LIMITS.entries),
    expandedBytes: tightened('PICPEAK_IMPORT_MAX_EXPANDED_BYTES', HARD_LIMITS.expandedBytes),
    manifestBytes: tightened('PICPEAK_IMPORT_MAX_MANIFEST_BYTES', HARD_LIMITS.manifestBytes),
  };
}

function safeSize(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw refusal(`Invalid archive ${name}.`);
  return value;
}

function pathParts(name, isDirectory) {
  if (typeof name !== 'string' || !name || Buffer.byteLength(name, 'utf8') > HARD_LIMITS.nameBytes ||
      name.includes('\\') || name.includes('\ufffd') ||
      Array.from(name).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) {
    throw refusal('Invalid or overlong archive entry name.');
  }
  const key = isDirectory && name.endsWith('/') ? name.slice(0, -1) : name;
  const parts = key.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || part.includes(':'))) {
    throw refusal('Invalid archive entry path.');
  }
  return { key, parts };
}

function createCensus(options = {}, bound = limits()) {
  const names = new Set();
  const nodes = new Map();
  const explicitDirectories = [];
  const fileAncestors = new Set();
  const allowedTables = options.allowedTables === undefined ? null : new Set(options.allowedTables);
  let count = 0;
  let centralBytes = 0;
  let expandedBytes = 0;
  function add(entry) {
    if (!entry || typeof entry !== 'object') throw refusal('Invalid archive entry.');
    if (++count > bound.entries) {
      throw refusal(`The backup exceeds PICPEAK_IMPORT_MAX_ENTRIES (${bound.entries}).`, 413);
    }
    const directory = entry.isDirectory === true;
    const { key, parts } = pathParts(entry.name, directory);
    if (entry.fnameLen !== undefined && entry.fnameLen > bound.nameBytes) throw refusal('Overlong archive entry name.');
    if (names.has(entry.name)) throw refusal('Duplicate archive entry.');
    names.add(entry.name);
    centralBytes += 46 + safeSize(entry.fnameLen === undefined ? Buffer.byteLength(entry.name) : entry.fnameLen, 'name length') +
      safeSize(entry.extraLen === undefined ? 0 : entry.extraLen, 'extra length') +
      safeSize(entry.comLen === undefined ? 0 : entry.comLen, 'comment length');
    if (centralBytes > bound.centralBytes) throw refusal('The backup central directory exceeds its hard metadata limit.', 413);
    const size = safeSize(entry.size, 'expanded size');
    if (entry.encrypted || (entry.method !== undefined && entry.method !== 0 && entry.method !== 8)) {
      throw refusal('Encrypted or unsupported-compression archive entries are not supported.');
    }
    const unixType = ((entry.attr || 0) >>> 16) & 0o170000;
    if (unixType && unixType !== (directory ? 0o040000 : 0o100000)) {
      throw refusal('Archive links and special files are not supported.');
    }
    if (directory) {
      if (size !== 0 || (parts[0] !== 'data' && parts[0] !== 'files') ||
          (parts[0] === 'data' && parts.length !== 1)) throw refusal('Unsupported archive directory layout.');
      explicitDirectories.push(key);
    } else if (key === 'manifest.json') {
      if (size > bound.manifestBytes) throw refusal('The backup manifest is too large to be a PicPeak manifest.');
    } else if (parts[0] === 'data' && parts.length === 2 && /^[A-Za-z_][A-Za-z0-9_]*\.ndjson$/.test(parts[1])) {
      entry.ignoredTable = allowedTables !== null && !allowedTables.has(parts[1].slice(0, -7));
    } else if (parts[0] === 'files' && parts.length > 1) {
      if (typeof options.validateFileKey !== 'function') throw refusal('No portable file policy was supplied.');
      const problem = options.validateFileKey(parts.slice(1).join('/'));
      if (problem) throw refusal(`Archive contains a file PicPeak would not have exported (${problem}): ${entry.name}`, 400, 'UNSUPPORTED_ARCHIVE_FILE');
    } else {
      throw refusal('Unsupported archive entry layout.');
    }
    for (let i = 1; i < parts.length; i++) {
      const ancestor = parts.slice(0, i).join('/');
      if (nodes.get(ancestor) === 'file') throw refusal('Archive file/directory path collision.');
      nodes.set(ancestor, 'directory');
      if (!directory) fileAncestors.add(ancestor);
      if (nodes.size > HARD_LIMITS.entries) throw refusal('The backup exceeds its hard ancestor/inode limit.', 413);
    }
    const prior = nodes.get(key);
    if ((directory && prior === 'file') || (!directory && prior)) throw refusal('Archive file/directory path collision.');
    nodes.set(key, directory ? 'directory' : 'file');
    if (nodes.size > HARD_LIMITS.entries) throw refusal('The backup exceeds its hard ancestor/inode limit.', 413);
    if (!directory) {
      expandedBytes += size;
      if (expandedBytes > bound.expandedBytes) {
        throw refusal(`The backup exceeds PICPEAK_IMPORT_MAX_EXPANDED_BYTES (${bound.expandedBytes}).`, 413);
      }
    }
  }
  function finish() {
    for (const directory of explicitDirectories) {
      if (directory === 'data' || directory === 'files') continue;
      const rel = directory.slice('files/'.length);
      const allowed = typeof options.validateFileKey === 'function' && !options.validateFileKey(`${rel}/__picpeak_directory__`);
      if (!allowed && !fileAncestors.has(directory)) {
        throw refusal('Unsupported archive directory layout.');
      }
    }
    return { entries: count, expandedBytes, centralBytes, inodes: nodes.size };
  }
  return { add, finish };
}

function sameSource(before, after) {
  return after.isFile() && after.nlink === 1 && before.dev === after.dev && before.ino === after.ino &&
    before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs;
}

async function openBoundedArchive(file, options = {}) {
  const bound = limits();
  const absolute = path.resolve(file);
  if (await fsp.realpath(absolute) !== absolute) throw refusal('Archive source must not traverse symlinks.');
  const fd = await openFd(absolute, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let handedOff = false;
  try {
    const source = await statFd(fd);
    if (!source.isFile() || source.nlink !== 1 || !Number.isSafeInteger(source.size)) {
      throw refusal('Archive source must be a single-link regular file.');
    }
    const zip = new StreamZip({ fd, storeEntries: false, chunkSize: 128 * 1024 });
    handedOff = true;
    const entries = Object.create(null);
    const census = createCensus(options, bound);
    const active = new Set();
    const starting = new Set();
    let closed = false;
    let closePromise;
    let ready = false;
    let terminalError;
    const close = () => {
      if (closePromise) return closePromise;
      closed = true;
      closePromise = (async () => {
        await Promise.allSettled([...starting]);
        for (const task of active) task.output.destroy(refusal('Archive closed.'));
        await Promise.all([...active].map(task => task.done));
        await new Promise((resolve, reject) => zip.close(error => error ? reject(error) : resolve()));
      })();
      return closePromise;
    };
    await new Promise((resolve, reject) => {
      zip.on('entry', entry => { census.add(entry); entries[entry.name] = entry; });
      zip.on('error', original => {
        const error = original.statusCode ? original : Object.assign(refusal('Unable to read the portable archive.'), { cause: original });
        terminalError = error;
        if (!ready) close().then(() => reject(error), closeError => { error.closeError = closeError; reject(error); });
      });
      zip.once('ready', () => {
        try {
          census.finish();
          if (!entries['manifest.json']) throw refusal('The archive has no manifest.json.');
          ready = true;
          resolve();
        } catch (error) {
          terminalError = error;
          close().then(() => reject(error), closeError => { error.closeError = closeError; reject(error); });
        }
      });
    });
    const assertOpen = () => {
      if (closed || terminalError) throw terminalError || refusal('Archive closed.');
    };
    const facade = {
      async entries() { assertOpen(); return entries; },
      async entry(name) { assertOpen(); return entries[name]; },
      async stream(name) {
        assertOpen();
        const entry = entries[name];
        if (!entry || entry.isDirectory) throw refusal('Archive file entry not found.');
        const task = (async () => {
          await new Promise((resolve, reject) => zip.openEntry(entry, error => error ? reject(error) : resolve()));
          assertOpen();
          if (!sameSource(source, await statFd(fd))) throw refusal('Archive source changed while open.');
          const start = safeSize(entry.offset, 'offset') + 30 + safeSize(entry.fnameLen, 'local name length') + safeSize(entry.extraLen, 'local extra length');
          const compressedSize = safeSize(entry.compressedSize, 'compressed size');
          if (!Number.isSafeInteger(start + compressedSize) || start + compressedSize > source.size ||
              entry.encrypted || (entry.method !== 0 && entry.method !== 8)) throw refusal('Invalid archive local entry.');
          let crc = 0;
          let bytes = 0;
          const verify = new Transform({
            transform(chunk, _encoding, callback) {
              bytes += chunk.length;
              if ((entry.flags & 8) === 0) crc = zlib.crc32(chunk, crc);
              callback(null, chunk);
            },
            flush(callback) {
              if ((entry.flags & 8) === 0 && (bytes !== entry.size || crc !== entry.crc)) {
                return callback(refusal('Archive entry checksum or size mismatch.'));
              }
              statFd(fd).then(after => callback(sameSource(source, after) ? undefined : refusal('Archive source changed while streaming.')), callback);
            },
          });
          const output = new PassThrough({
            highWaterMark: 64 * 1024,
            destroy(error, callback) {
              callback(error && !error.statusCode ? Object.assign(refusal('Unable to stream the portable archive entry.'), { cause: error }) : error);
            },
          });
          output.on('error', () => {}); // Consumers may attach after an immediate decompression error.
          const owned = { output, done: null };
          owned.done = new Promise(resolve => {
            const input = compressedSize === 0 ? Readable.from([]) :
              fs.createReadStream(absolute, {
                fd, autoClose: false, start, end: start + compressedSize - 1, highWaterMark: 64 * 1024,
                // pipeline destroys streams on cancellation even with autoClose
                // false. Only the archive owns this borrowed descriptor; Node's
                // destroy still waits for pending reads before this no-op close.
                fs: { read: fs.read.bind(fs), close: (_fd, callback) => callback() },
              });
            const streams = entry.method === 8 ? [input, zlib.createInflateRaw(), verify, output] : [input, verify, output];
            pipeline(...streams, error => {
              active.delete(owned);
              if (error) output.destroy(error.statusCode ? error : Object.assign(refusal('Unable to stream the portable archive entry.'), { cause: error }));
              resolve();
            });
          });
          active.add(owned);
          return output;
        })();
        starting.add(task);
        try { return await task; } finally { starting.delete(task); }
      },
      close,
    };
    facadeState.set(facade, { options, bound });
    return facade;
  } catch (error) {
    if (!handedOff) await closeFd(fd).catch(closeError => { error.closeError = closeError; });
    throw error;
  }
}

function measuredInteger(value) {
  if (typeof value === 'bigint' && value >= 0n) return value;
  if (Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  throw refusal('Filesystem capacity cannot be measured safely.', 507);
}

async function capacity(directory, bytes = 0, inodes = 0) {
  try {
    if (typeof fsp.statfs !== 'function') throw refusal('Filesystem capacity is unavailable.', 507);
    const stats = await fsp.statfs(directory, { bigint: true });
    if (!LOCAL_FILESYSTEMS.has(measuredInteger(stats.type))) throw refusal('Restore workspace must use a supported local filesystem.', 507);
    const bsize = measuredInteger(stats.bsize);
    const bavail = measuredInteger(stats.bavail);
    const ffree = measuredInteger(stats.ffree);
    if (bsize === 0n || bavail * bsize < BigInt(bytes) + BigInt(HARD_LIMITS.reserveBytes) ||
        ffree < BigInt(inodes) + BigInt(HARD_LIMITS.reserveInodes)) {
      throw refusal('Insufficient measured bytes or inodes for the restore workspace.', 507);
    }
    return { bytes: bavail * bsize, inodes: ffree };
  } catch (error) {
    if (error.statusCode === 507) throw error;
    throw refusal('Filesystem capacity cannot be measured safely.', 507);
  }
}

async function workspaceRoot(workspace, options) {
  const root = path.resolve(workspace);
  if (await fsp.realpath(root) !== root) throw refusal('Restore workspace must not traverse symlinks.');
  const stat = await fsp.lstat(root);
  if (!stat.isDirectory() || (stat.mode & 0o777) !== 0o700 ||
      (typeof process.getuid === 'function' && stat.uid !== process.getuid())) {
    throw refusal('Restore workspace must be a private owned 0700 directory.');
  }
  if (options.persistentRoot) {
    const storage = await fsp.stat(await fsp.realpath(options.persistentRoot));
    if (!storage.isDirectory() || storage.dev !== stat.dev) throw refusal('Restore workspace is not on its persistent storage volume.');
  }
  await capacity(root);
  return root;
}

async function targetPath(root, entry, create) {
  const { parts } = pathParts(entry.name, entry.isDirectory === true);
  let parent = root;
  const depth = entry.isDirectory ? parts.length : parts.length - 1;
  for (let i = 0; i < depth; i++) {
    parent = path.join(parent, parts[i]);
    let stat;
    try { stat = await fsp.lstat(parent); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (!create) continue;
      await capacity(root, 0, 1);
      await fsp.mkdir(parent, { mode: 0o700 });
      stat = await fsp.lstat(parent);
    }
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700)) {
      throw refusal('Restore workspace contains an unsafe directory.');
    }
  }
  const target = path.join(root, ...parts);
  if (!entry.isDirectory) {
    try { await fsp.lstat(target); throw refusal('Restore extraction target already exists.'); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return target;
}

async function assertArchiveWithinLimits(entries, workspace, options = {}) {
  const census = createCensus(options);
  for (const entry of entries || []) census.add(entry);
  const result = census.finish();
  const root = await workspaceRoot(workspace, options);
  await capacity(root, result.expandedBytes, result.inodes);
  for (const entry of entries || []) await targetPath(root, entry, false);
  return { entries: result.entries, expandedBytes: result.expandedBytes };
}

async function extractWithinLimits(zip, entries, workspace, options = {}) {
  const state = facadeState.get(zip);
  const policy = { ...(state ? state.options : {}), ...options };
  const bound = state ? state.bound : limits();
  await assertArchiveWithinLimits(entries, workspace, policy);
  const root = await workspaceRoot(workspace, policy);
  let expandedBytes = 0;
  let sinceMeasure = HARD_LIMITS.measureInterval;
  for (const entry of entries) {
    const target = await targetPath(root, entry, true);
    if (entry.isDirectory) continue;
    await capacity(root, 0, 1);
    let output;
    let created = false;
    let input;
    try {
      output = await fsp.open(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      created = true;
      input = await zip.stream(entry.name);
      for await (const chunk of input) {
        if (expandedBytes + chunk.length > bound.expandedBytes) {
          throw refusal(`The backup exceeds PICPEAK_IMPORT_MAX_EXPANDED_BYTES (${bound.expandedBytes}).`, 413);
        }
        // Measurement precedes a bounded write. No more than 1 MiB is written
        // between measurements, including entries with understated headers.
        for (let offset = 0; offset < chunk.length;) {
          const length = Math.min(chunk.length - offset, HARD_LIMITS.measureInterval - (sinceMeasure % HARD_LIMITS.measureInterval));
          if (sinceMeasure >= HARD_LIMITS.measureInterval) {
            await capacity(root, HARD_LIMITS.measureInterval, 0);
            sinceMeasure = 0;
          }
          let written = 0;
          while (written < length) {
            const result = await output.write(chunk, offset + written, length - written);
            if (!result.bytesWritten) throw refusal('Restore extraction made no write progress.', 507);
            written += result.bytesWritten;
          }
          offset += length;
          expandedBytes += length;
          sinceMeasure += length;
        }
      }
      await output.sync();
      await output.close();
      output = null;
    } catch (error) {
      if (input) input.destroy();
      if (output) await output.close().catch(() => {});
      if (created) await fsp.unlink(target).catch(() => {});
      throw error;
    }
  }
  return { expandedBytes };
}

async function readEntryWithin(zip, name, maxBytes, onExceed) {
  const state = facadeState.get(zip);
  const ceiling = name === 'manifest.json' ? (state ? state.bound.manifestBytes : limits().manifestBytes) : HARD_LIMITS.manifestBytes;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw refusal('Invalid archive entry read limit.');
  const limit = Math.min(maxBytes, ceiling);
  const input = await zip.stream(name);
  const chunks = [];
  let bytes = 0;
  try {
    for await (const chunk of input) {
      if (bytes + chunk.length > limit) throw onExceed ? onExceed() : refusal('Archive entry exceeds its bounded read limit.', 413);
      bytes += chunk.length;
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, bytes);
  } catch (error) {
    input.destroy();
    throw error;
  }
}

module.exports = { HARD_LIMITS, openBoundedArchive, assertArchiveWithinLimits, extractWithinLimits, readEntryWithin };
