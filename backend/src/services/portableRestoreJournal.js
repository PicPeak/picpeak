'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { TextDecoder } = require('util');

const VERSION = 1;
const MAX_LINE = 8192;
const MAX_STATE = 32768;
const MAX_FILES = 100000;
const MAX_BYTES = 64 * 1024 ** 3;
const RESERVE_BYTES = 256 * 1024 ** 2;
const RESERVE_INODES = 1024;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const SHA256 = /^[a-f0-9]{64}$/;
// Network filesystems do not provide the local-process termination guarantee
// used by recovery. S3 objects instead use their separately committed index.
const LOCAL_FILESYSTEMS = new Set([0xef53n, 0x58465342n, 0x9123683en, 0x01021994n,
  0x794c7630n, 0x2fc12fc1n, 0xf2f52010n]);
const decoder = new TextDecoder('utf-8', { fatal: true });

function fail(message) {
  const error = new Error(message);
  error.code = 'RESTORE_JOURNAL_UNSAFE';
  return error;
}

function validateId(id) {
  if (typeof id !== 'string' || !UUID.test(id)) throw fail('Invalid restore journal identity');
}

async function syncDirectory(directory) {
  const handle = await fsp.open(directory, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}

async function regularFile(file) {
  const handle = await fsp.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid()
        || !Number.isSafeInteger(stat.size)) throw fail('Restore requires an owned regular, singly linked file');
    return { handle, stat };
  } catch (error) { await handle.close(); throw error; }
}

async function boundedHash(file, expectedSize) {
  const { handle, stat } = await regularFile(file);
  const hash = crypto.createHash('sha256');
  let size = 0;
  try {
    if (stat.size !== expectedSize) throw fail('Restore file size changed');
    for await (const chunk of handle.createReadStream({ autoClose: false, highWaterMark: 65536 })) {
      size += chunk.length;
      if (size > expectedSize) throw fail('Restore file grew during verification');
      hash.update(chunk);
    }
    const after = await handle.stat();
    if (size !== expectedSize || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) {
      throw fail('Restore file changed during verification');
    }
    return hash.digest('hex');
  } finally { await handle.close(); }
}

async function copyVerified(source, destination, size, checksum, mode = 0o600) {
  const { handle: input, stat } = await regularFile(source);
  let output;
  const hash = crypto.createHash('sha256');
  let position = 0;
  try {
    if (stat.size !== size) throw fail('Restore source size changed');
    output = await fsp.open(destination, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, mode);
    for await (const chunk of input.createReadStream({ autoClose: false, highWaterMark: 65536 })) {
      if (position + chunk.length > size) throw fail('Restore source grew during copy');
      hash.update(chunk);
      let offset = 0;
      while (offset < chunk.length) {
        const { bytesWritten } = await output.write(chunk, offset, chunk.length - offset, position);
        if (!bytesWritten) throw fail('Restore copy made no progress');
        offset += bytesWritten;
        position += bytesWritten;
      }
    }
    const after = await input.stat();
    const actual = hash.digest('hex');
    if (position !== size || actual !== checksum || after.size !== stat.size
        || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) throw fail('Restore copy checksum/source changed');
    await output.chmod(mode);
    await output.sync();
  } catch (error) {
    if (output) await fsp.unlink(destination).catch(() => {});
    throw error;
  } finally {
    await input.close();
    if (output) await output.close();
  }
}

// Bound each line before concatenation/decoding, not after readline has already
// allocated an arbitrarily large line. A journal is streamed during recovery.
async function* readRecords(file) {
  const { handle, stat } = await regularFile(file);
  if (stat.size > MAX_FILES * MAX_LINE) { await handle.close(); throw fail('Restore journal exceeds its record bound'); }
  let tail = Buffer.alloc(0);
  try {
    for await (const chunk of handle.createReadStream({ autoClose: false, highWaterMark: 65536 })) {
      let start = 0;
      for (;;) {
        const end = chunk.indexOf(10, start);
        const part = chunk.subarray(start, end === -1 ? chunk.length : end);
        if (tail.length + part.length > MAX_LINE) throw fail('Restore journal line exceeds its bound');
        tail = tail.length ? Buffer.concat([tail, part]) : part;
        if (end === -1) break;
        if (!tail.length) throw fail('Restore journal contains an empty record');
        yield JSON.parse(decoder.decode(tail));
        tail = Buffer.alloc(0);
        start = end + 1;
      }
    }
    if (tail.length) throw fail('Restore journal has an incomplete record');
  } finally { await handle.close(); }
}

async function readState(file) {
  const { handle, stat } = await regularFile(file);
  try {
    if (!stat.size || stat.size > MAX_STATE) throw fail('Invalid restore journal state size');
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) throw fail('Restore journal state was truncated');
      offset += bytesRead;
    }
    if ((await handle.stat()).size !== stat.size) throw fail('Restore journal state changed');
    return JSON.parse(decoder.decode(bytes));
  } finally { await handle.close(); }
}

class PortableRestoreJournal {
  constructor({ root, directory, id, validateKey, state }) {
    this.root = root;
    this.directory = directory;
    this.id = id;
    this.keyProblem = validateKey;
    this.state = state;
    this.plan = path.join(directory, 'plan.ndjson');
  }

  static async create({ storageRoot, id = crypto.randomUUID(), validateKey, reuseWorkerDirectory = false }) {
    validateId(id);
    if (typeof validateKey !== 'function') throw fail('Restore journal requires the portable file policy');
    const root = await fsp.realpath(storageRoot);
    const privateRoot = path.join(root, '.picpeak-maintenance');
    await fsp.mkdir(privateRoot, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
    const privateStat = await fsp.lstat(privateRoot);
    if (!privateStat.isDirectory() || privateStat.isSymbolicLink() || privateStat.uid !== process.getuid()
        || (privateStat.mode & 0o077) !== 0) throw fail('Unsafe restore journal directory');
    const directory = path.join(privateRoot, id);
    try { await fsp.mkdir(directory, { mode: 0o700 }); } catch (error) {
      if (error.code !== 'EEXIST' || !reuseWorkerDirectory) throw error;
      const stat = await fsp.lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid()
          || (stat.mode & 0o077) !== 0) throw fail('Unsafe existing restore worker directory');
      for (const name of await fsp.readdir(directory)) {
        if (!['worker.lease', 'request.json', 'request.picpeak', 'workspace'].includes(name)) throw fail('Restore worker directory already contains a journal');
        const entry = await fsp.lstat(path.join(directory, name));
        if (entry.isSymbolicLink() || entry.uid !== process.getuid() || (entry.mode & 0o077) !== 0
            || (name === 'workspace' ? !entry.isDirectory() : (!entry.isFile() || entry.nlink !== 1))) throw fail('Unsafe restore worker directory entry');
      }
    }
    await fsp.mkdir(path.join(directory, 'undo'), { mode: 0o700 });
    await fsp.mkdir(path.join(directory, 'new'), { mode: 0o700 });
    await syncDirectory(privateRoot);
    const journal = new PortableRestoreJournal({ root, directory, id, validateKey,
      state: { version: VERSION, id, root, phase: 'preparing', files: 0, bytes: 0 } });
    await journal.assertCapacity();
    await journal.writeState();
    return journal;
  }

  static async load({ storageRoot, id, validateKey }) {
    validateId(id);
    if (typeof validateKey !== 'function') throw fail('Restore journal requires the portable file policy');
    const root = await fsp.realpath(storageRoot);
    const directory = path.join(root, '.picpeak-maintenance', id);
    // No path component may redirect a recovery operation out of this volume.
    if (await fsp.realpath(directory) !== directory) throw fail('Restore journal path is redirected');
    const stat = await fsp.lstat(directory);
    const parent = await fsp.lstat(path.dirname(directory));
    if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0
        || !parent.isDirectory() || parent.uid !== process.getuid() || (parent.mode & 0o077) !== 0) throw fail('Unsafe restore journal permissions');
    for (const name of ['undo', 'new']) {
      const child = await fsp.lstat(path.join(directory, name));
      if (!child.isDirectory() || child.isSymbolicLink() || child.uid !== process.getuid()
          || child.dev !== stat.dev || (child.mode & 0o077) !== 0) throw fail('Unsafe restore journal staging directory');
    }
    const state = await readState(path.join(directory, 'state.json'));
    if (state.version !== VERSION || state.id !== id || state.root !== root
        || !['preparing', 'prepared', 'promoting', 'promoted', 'rolled_back'].includes(state.phase)
        || !Number.isSafeInteger(state.files) || state.files < 0 || state.files > MAX_FILES
        || !Number.isSafeInteger(state.bytes) || state.bytes < 0 || state.bytes > MAX_BYTES
        || (state.phase !== 'preparing' && !state.abortedPreparation
          && (!Number.isSafeInteger(state.planSize) || state.planSize < 0 || state.planSize > MAX_FILES * MAX_LINE
            || typeof state.planChecksum !== 'string' || !SHA256.test(state.planChecksum)))
        || (state.abortedPreparation && (state.phase !== 'rolled_back' || state.files !== 0 || state.bytes !== 0))) throw fail('Invalid restore journal state');
    const journal = new PortableRestoreJournal({ root, directory, id, validateKey, state });
    await journal.assertCapacity();
    return journal;
  }

  async writeState() {
    const target = path.join(this.directory, 'state.json');
    const temporary = path.join(this.directory, `state-${crypto.randomUUID()}.next`);
    const value = JSON.stringify(this.state);
    if (Buffer.byteLength(value) > MAX_STATE) throw fail('Restore journal state exceeds its bound');
    const handle = await fsp.open(temporary, 'wx', 0o600);
    try { await handle.writeFile(value); await handle.sync(); } finally { await handle.close(); }
    await fsp.rename(temporary, target);
    await syncDirectory(this.directory);
  }

  key(key) {
    if (typeof key !== 'string' || !key || Buffer.byteLength(key) > 1024
        || Array.from(key).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) || key.includes('\\')
        || key.split('/').some(part => !part || part === '.' || part === '..')
        || key.startsWith('.picpeak-maintenance/') || this.keyProblem(key)) throw fail('Invalid restore journal file key');
    return key;
  }

  async destination(key, { createParents = false } = {}) {
    this.key(key);
    const parts = key.split('/');
    let current = this.root;
    for (const part of parts.slice(0, -1)) {
      current = path.join(current, part);
      let stat;
      try { stat = await fsp.lstat(current); } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        if (!createParents) continue;
        await fsp.mkdir(current, { mode: 0o700 });
        await syncDirectory(path.dirname(current));
        stat = await fsp.lstat(current);
      }
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== (await fsp.lstat(this.directory)).dev) throw fail('Restore destination has a non-directory, redirected or separate-volume parent');
    }
    const destination = path.join(this.root, ...parts);
    try {
      const stat = await fsp.lstat(destination);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw fail('Restore destination is not a regular file');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    return destination;
  }

  async assertCapacity(bytes = 0, files = 0) {
    const stat = await fsp.statfs(this.root, { bigint: true });
    if (!LOCAL_FILESYSTEMS.has(BigInt.asUintN(32, stat.type))) throw fail('Coordinated local restore requires a supported local filesystem');
    if (stat.bavail * stat.bsize < BigInt(bytes + RESERVE_BYTES)
        || stat.ffree < BigInt(files + RESERVE_INODES)) throw fail('Insufficient measured restore disk/inode reserve');
  }

  validateRecord(record, index) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) throw fail('Invalid restore journal record');
    this.key(record.key);
    if (record.index !== index || !Number.isSafeInteger(record.size) || record.size < 0 || record.size > MAX_BYTES
        || typeof record.checksum !== 'string' || !SHA256.test(record.checksum) || typeof record.old !== 'boolean'
        || !Array.isArray(record.parents) || record.parents.length > 512) throw fail('Invalid restore journal record');
    const ancestors = record.key.split('/').slice(0, -1).map((_, i, parts) => parts.slice(0, i + 1).join('/'));
    const seenParents = new Set();
    for (const parent of record.parents) {
      if (typeof parent !== 'string' || !ancestors.includes(parent) || seenParents.has(parent)) throw fail('Invalid restore parent undo record');
      seenParents.add(parent);
    }
    if (record.old && record.parents.length) throw fail('Existing restore file has missing parents');
    if (record.old && (!Number.isSafeInteger(record.oldSize) || record.oldSize < 0 || record.oldSize > MAX_BYTES
        || !SHA256.test(record.oldChecksum || '') || !Number.isSafeInteger(record.mode) || record.mode < 0 || record.mode > 0o777
        || !Number.isFinite(record.atime) || !Number.isFinite(record.mtime))) throw fail('Invalid restore journal undo record');
  }

  async *records() {
    let index = 0;
    let bytes = 0;
    for await (const record of readRecords(this.plan)) {
      if (index >= MAX_FILES) throw fail('Restore journal has too many records');
      this.validateRecord(record, index++);
      bytes += record.size + (record.old ? record.oldSize : 0);
      if (bytes > MAX_BYTES) throw fail('Restore journal exceeds its byte budget');
      yield record;
    }
    if (index !== this.state.files || bytes !== this.state.bytes) throw fail('Restore journal plan does not match its durable state');
  }

  async validatePlan({ undo = false, staged = false, destinations = false } = {}) {
    // Validate the complete sealed plan (and every required undo) before the
    // first live mutation. A valid prefix is not a valid recovery journal.
    if (await boundedHash(this.plan, this.state.planSize) !== this.state.planChecksum) throw fail('Restore journal plan checksum changed');
    const seen = new Set();
    for await (const record of this.records()) {
      if (seen.has(record.key)) throw fail('Duplicate restore journal key');
      seen.add(record.key);
      if (undo && record.old && await boundedHash(path.join(this.directory, 'undo', String(record.index)), record.oldSize) !== record.oldChecksum) throw fail('Restore undo checksum changed');
      if (staged && await boundedHash(path.join(this.directory, 'new', String(record.index)), record.size) !== record.checksum) throw fail('Restore staged checksum changed');
      if (destinations) await this.current(record);
    }
  }

  async current(record, { beforePromotion = false } = {}) {
    const destination = await this.destination(record.key);
    let current;
    try {
      const stat = await fsp.lstat(destination);
      if (stat.size !== record.size && (!record.old || stat.size !== record.oldSize)) throw fail('Restore destination size changed outside the fenced journal');
      current = { size: stat.size, checksum: await boundedHash(destination, stat.size) };
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const sameOld = record.old && current?.size === record.oldSize && current.checksum === record.oldChecksum;
    const sameNew = current?.size === record.size && current.checksum === record.checksum;
    if (beforePromotion ? (record.old ? !sameOld : Boolean(current)) : (current && !sameOld && !sameNew)) {
      throw fail('Restore destination changed outside the fenced journal');
    }
    return { destination, current, sameOld, sameNew };
  }

  async missingParents(key) {
    const parts = key.split('/').slice(0, -1);
    const parents = [];
    for (let i = 0; i < parts.length; i++) {
      const parent = parts.slice(0, i + 1).join('/');
      try { await fsp.lstat(path.join(this.root, parent)); } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        parents.push(parent);
      }
    }
    return parents;
  }

  async prepare(sourceRoot, keys) {
    if (this.state.phase !== 'preparing') throw fail('Restore journal was already prepared');
    const source = await fsp.realpath(sourceRoot);
    const temporaryPlan = path.join(this.directory, 'plan.next');
    const plan = await fsp.open(temporaryPlan, 'wx', 0o600);
    let files = 0;
    let bytes = 0;
    let largestOld = 0;
    const seen = new Set();
    try {
      for await (const entry of keys) {
        const key = this.key(entry);
        if (seen.has(key) || files >= MAX_FILES) throw fail('Duplicate or excessive restore journal file');
        seen.add(key);
        const staged = path.join(source, ...key.split('/'));
        if (await fsp.realpath(staged) !== staged) throw fail('Restore source path is redirected');
        const stagedStat = await fsp.lstat(staged);
        if (!stagedStat.isFile() || !Number.isSafeInteger(stagedStat.size)) throw fail('Invalid restore staged file');
        const destination = await this.destination(key);
        let oldStat;
        try { oldStat = await fsp.lstat(destination); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        const oldSize = oldStat?.size || 0;
        bytes += stagedStat.size + oldSize;
        largestOld = Math.max(largestOld, oldSize);
        if (!Number.isSafeInteger(bytes) || bytes > MAX_BYTES) throw fail('Restore journal exceeds its byte budget');
        await this.assertCapacity(oldSize + stagedStat.size + largestOld, 4);
        const record = { index: files++, key, size: stagedStat.size,
          checksum: await boundedHash(staged, stagedStat.size), old: Boolean(oldStat),
          parents: await this.missingParents(key) };
        if (oldStat) {
          record.oldSize = oldStat.size;
          record.oldChecksum = await boundedHash(destination, oldStat.size);
          record.mode = oldStat.mode & 0o777;
          record.atime = oldStat.atimeMs / 1000;
          record.mtime = oldStat.mtimeMs / 1000;
          await copyVerified(destination, path.join(this.directory, 'undo', String(record.index)), record.oldSize, record.oldChecksum);
        }
        await copyVerified(staged, path.join(this.directory, 'new', String(record.index)), record.size, record.checksum, record.old ? record.mode : 0o600);
        const line = `${JSON.stringify(record)}\n`;
        if (Buffer.byteLength(line) > MAX_LINE) throw fail('Restore record exceeds its line budget');
        await plan.writeFile(line);
      }
      await plan.sync();
    } finally { await plan.close(); }
    await this.assertCapacity(largestOld, 4);
    await syncDirectory(path.join(this.directory, 'undo'));
    await syncDirectory(path.join(this.directory, 'new'));
    await fsp.rename(temporaryPlan, this.plan);
    await syncDirectory(this.directory);
    const planSize = (await fsp.lstat(this.plan)).size;
    this.state = { ...this.state, phase: 'prepared', files, bytes, planSize,
      planChecksum: await boundedHash(this.plan, planSize) };
    await this.writeState();
    return { id: this.id, files, bytes };
  }

  async promote(sourceRoot, { onStep = () => {} } = {}) {
    if (this.state.phase !== 'prepared') throw fail('Restore journal is not ready for promotion');
    // Staging is complete in the private same-volume journal. No untrusted
    // source path or application-visible temporary file is needed at cutover.
    await fsp.realpath(sourceRoot);
    await this.validatePlan({ undo: true, staged: true });
    for await (const record of this.records()) await this.current(record, { beforePromotion: true });
    this.state.phase = 'promoting';
    await this.writeState();
    for await (const record of this.records()) {
      const destination = await this.destination(record.key, { createParents: true });
      await this.current(record, { beforePromotion: true });
      await fsp.rename(path.join(this.directory, 'new', String(record.index)), destination);
      await syncDirectory(path.dirname(destination));
      await syncDirectory(path.join(this.directory, 'new'));
      await onStep('promoted', record);
    }
    this.state.phase = 'promoted';
    await this.writeState();
  }

  async rollback({ onStep = () => {} } = {}) {
    if (this.state.phase === 'preparing') {
      // Promotion cannot begin until both the complete plan and prepared state
      // are durable. Incomplete preparation therefore changed no live files.
      this.state.phase = 'rolled_back';
      this.state.files = 0;
      this.state.bytes = 0;
      this.state.abortedPreparation = true;
      await this.writeState();
      return;
    }
    if (this.state.abortedPreparation) return;
    await this.validatePlan({ undo: true, destinations: true });
    for await (const record of this.records()) {
      const { destination, current, sameOld } = await this.current(record);
      if (record.old) {
        if (!sameOld) {
          await this.destination(record.key, { createParents: true });
          const temporary = path.join(this.directory, `rollback-${record.index}.next`);
          let ownsTemporary = false;
          try {
            await this.assertCapacity(record.oldSize, 2);
            // Only this sealed journal owns the deterministic recovery temp.
            // A crash during copying may leave it incomplete; it is never live.
            try {
              const stat = await fsp.lstat(temporary);
              if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid()) throw fail('Unsafe restore recovery temporary file');
              await fsp.unlink(temporary);
            } catch (error) { if (error.code !== 'ENOENT') throw error; }
            await copyVerified(path.join(this.directory, 'undo', String(record.index)), temporary, record.oldSize, record.oldChecksum, record.mode);
            ownsTemporary = true;
            await this.current(record);
            await fsp.rename(temporary, destination);
            ownsTemporary = false;
          } finally { if (ownsTemporary) await fsp.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
        }
        const handle = await fsp.open(destination, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        try {
          await handle.chmod(record.mode);
          await handle.utimes(record.atime, record.mtime);
          await handle.sync();
        } finally { await handle.close(); }
      } else if (current) await fsp.unlink(destination);
      if (record.old || current) await syncDirectory(path.dirname(destination));
      for (const parent of record.parents.slice().reverse()) {
        const directory = path.join(this.root, parent);
        try {
          const stat = await fsp.lstat(directory);
          if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail('Restore created directory is redirected');
          await fsp.rmdir(directory);
          await syncDirectory(path.dirname(directory));
        } catch (error) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error; }
      }
      await onStep('rolled_back', record);
    }
    this.state.phase = 'rolled_back';
    await this.writeState();
  }

  async verifyCommitted() {
    // Only the matching database marker, not this state file, decides whether
    // a restore committed. Recovery callers must establish it before this call.
    if (!['promoting', 'promoted'].includes(this.state.phase)) throw fail('Restore file promotion was not recorded');
    await this.validatePlan();
    for await (const record of this.records()) {
      const destination = await this.destination(record.key);
      if (await boundedHash(destination, record.size) !== record.checksum) throw fail('Committed restore file checksum does not match');
    }
  }
}

module.exports = { PortableRestoreJournal, MAX_FILES, MAX_BYTES, readRecords };
