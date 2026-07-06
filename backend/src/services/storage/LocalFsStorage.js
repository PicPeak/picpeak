const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const { pipeline } = require('stream/promises');
const crypto = require('crypto');

const logger = require('../../utils/logger');

/**
 * Filesystem-backed implementation of the StorageBackend interface.
 * All keys are relative to `root` (typically process.env.STORAGE_PATH).
 *
 * Path traversal protection: every key is normalized to POSIX form and rejected
 * if it tries to escape the root via "..". Callers should not need to think
 * about this — but if a key arrives via user input it must still be filtered.
 */
class LocalFsStorage {
  constructor({ root }) {
    if (!root) throw new Error('LocalFsStorage requires a `root` directory');
    this.root = path.resolve(root);
  }

  kind() {
    return 'local';
  }

  async init() {
    await fsp.mkdir(this.root, { recursive: true });
    // Sanity check: must be writable.
    const probe = path.join(this.root, '.storage-write-probe');
    await fsp.writeFile(probe, '');
    await fsp.unlink(probe);
    logger.info(`[storage] LocalFsStorage initialized at ${this.root}`);
  }

  _resolve(relPath) {
    if (!relPath || typeof relPath !== 'string') {
      throw new Error(`LocalFsStorage: invalid relative path: ${relPath}`);
    }
    const normalized = path.posix.normalize(relPath.replace(/\\/g, '/'));
    if (normalized.startsWith('..') || normalized.includes('/../') || normalized === '..') {
      throw new Error(`LocalFsStorage: path traversal rejected: ${relPath}`);
    }
    return path.join(this.root, normalized);
  }

  async put(relPath, body, _options = {}) {
    const abs = this._resolve(relPath);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    // Write to a sibling tmp file first then rename for crash safety.
    const tmp = `${abs}.tmp.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
    try {
      if (Buffer.isBuffer(body)) {
        await fsp.writeFile(tmp, body);
      } else if (body && typeof body.pipe === 'function') {
        await pipeline(body, fs.createWriteStream(tmp));
      } else {
        throw new Error('LocalFsStorage.put: body must be a Buffer or Readable stream');
      }
      await fsp.rename(tmp, abs);
    } catch (err) {
      await fsp.unlink(tmp).catch(() => {});
      throw err;
    }
  }

  async putFromFile(relPath, localPath, _options = {}) {
    const abs = this._resolve(relPath);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    // copyFile is atomic from the destination's perspective on POSIX.
    await fsp.copyFile(localPath, abs);
  }

  async get(relPath) {
    const abs = this._resolve(relPath);
    return fs.createReadStream(abs);
  }

  async getRange(relPath, start, end) {
    const abs = this._resolve(relPath);
    return fs.createReadStream(abs, { start, end });
  }

  async getToFile(relPath, localPath) {
    const abs = this._resolve(relPath);
    await fsp.mkdir(path.dirname(localPath), { recursive: true });
    await fsp.copyFile(abs, localPath);
  }

  async exists(relPath) {
    try {
      await fsp.access(this._resolve(relPath), fs.constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  async stat(relPath) {
    try {
      const s = await fsp.stat(this._resolve(relPath));
      return { size: s.size, mtime: s.mtime };
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  }

  async delete(relPath) {
    try {
      await fsp.unlink(this._resolve(relPath));
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }

  async list(prefix) {
    const absPrefix = this._resolve(prefix || '.');
    const entries = [];
    async function walk(dir, relBase) {
      let dirents;
      try {
        dirents = await fsp.readdir(dir, { withFileTypes: true });
      } catch (err) {
        if (err.code === 'ENOENT') return;
        throw err;
      }
      for (const ent of dirents) {
        const childAbs = path.join(dir, ent.name);
        const childRel = relBase ? `${relBase}/${ent.name}` : ent.name;
        if (ent.isDirectory()) {
          await walk(childAbs, childRel);
        } else if (ent.isFile()) {
          const s = await fsp.stat(childAbs);
          entries.push({ key: childRel, size: s.size, mtime: s.mtime });
        }
      }
    }
    const baseRel = prefix && prefix !== '.' ? prefix.replace(/\\/g, '/') : '';
    await walk(absPrefix, baseRel);
    return entries;
  }

  async rename(srcRelPath, dstRelPath) {
    const src = this._resolve(srcRelPath);
    const dst = this._resolve(dstRelPath);
    await fsp.mkdir(path.dirname(dst), { recursive: true });
    await fsp.rename(src, dst);
  }

  async copy(srcRelPath, dstRelPath) {
    const src = this._resolve(srcRelPath);
    const dst = this._resolve(dstRelPath);
    await fsp.mkdir(path.dirname(dst), { recursive: true });
    await fsp.copyFile(src, dst);
  }

  async signedUrl(_relPath, _ttlSeconds = 300) {
    throw new Error('LocalFsStorage does not support signedUrl. Set STORAGE_BACKEND=s3 to use presigned URLs.');
  }

  // Escape hatch for callers that genuinely need a filesystem path
  // (e.g. ffmpeg, archiver — anything that takes a path argument rather
  // than a stream). S3Storage exposes the same method but returns null,
  // forcing callers to use the streaming API instead.
  resolveLocalPath(relPath) {
    return this._resolve(relPath);
  }
}

module.exports = LocalFsStorage;
