const path = require('path');
const fs = require('fs');
const fsp = require('fs').promises;
const { HeadObjectCommand } = require('@aws-sdk/client-s3');

const S3StorageAdapter = require('./s3Storage');
const logger = require('../../utils/logger');

/**
 * StorageBackend wrapper around the existing S3StorageAdapter.
 *
 * S3StorageAdapter was originally written for the backup service and exposes
 * upload/download/uploadStream/etc. This thin layer maps that surface onto the
 * canonical put/get/exists/delete/list/rename/copy/signedUrl interface used by
 * the rest of the codebase, and applies an optional `prefix` so a single bucket
 * can host multiple deployments without collisions.
 *
 * Atomicity: S3 has no rename. `rename()` is implemented as `copy()` + `delete()`.
 * If the process crashes between the two, the source object remains until the
 * next list-and-prune sweep — see `cleanupAbandonedTempUploads()` callers.
 */
class S3StorageBackend {
  constructor(config) {
    if (!config || !config.bucket) {
      throw new Error('S3StorageBackend requires a bucket name');
    }
    this.adapter = new S3StorageAdapter(config);
    this.prefix = (config.prefix || '').replace(/^\/+|\/+$/g, '');
  }

  kind() {
    return 's3';
  }

  _key(relPath) {
    if (!relPath || typeof relPath !== 'string') {
      throw new Error(`S3StorageBackend: invalid relative path: ${relPath}`);
    }
    const normalized = relPath.replace(/\\/g, '/').replace(/^\.?\/+/, '');
    if (normalized.startsWith('..') || normalized.includes('/../')) {
      throw new Error(`S3StorageBackend: path traversal rejected: ${relPath}`);
    }
    return this.prefix ? `${this.prefix}/${normalized}` : normalized;
  }

  async init() {
    await this.adapter.testConnection();
    logger.info(`[storage] S3StorageBackend initialized bucket=${this.adapter.bucket} prefix=${this.prefix || '(none)'}`);
  }

  async put(relPath, body, options = {}) {
    const key = this._key(relPath);
    if (Buffer.isBuffer(body)) {
      const { Readable } = require('stream');
      const stream = Readable.from(body);
      await this.adapter.uploadStream(stream, key, {
        contentType: options.contentType,
        cacheControl: options.cacheControl,
      });
      return;
    }
    if (body && typeof body.pipe === 'function') {
      await this.adapter.uploadStream(body, key, {
        contentType: options.contentType,
        cacheControl: options.cacheControl,
      });
      return;
    }
    throw new Error('S3StorageBackend.put: body must be a Buffer or Readable stream');
  }

  async putFromFile(relPath, localPath, options = {}) {
    await this.adapter.upload(localPath, this._key(relPath), {
      contentType: options.contentType,
      cacheControl: options.cacheControl,
    });
  }

  async get(relPath) {
    return this.adapter.downloadStream(this._key(relPath));
  }

  async getRange(relPath, start, end) {
    return this.adapter.downloadStream(this._key(relPath), { range: `bytes=${start}-${end}` });
  }

  async getToFile(relPath, localPath) {
    await fsp.mkdir(path.dirname(localPath), { recursive: true });
    await this.adapter.download(this._key(relPath), localPath);
  }

  async exists(relPath) {
    return this.adapter.exists(this._key(relPath));
  }

  async stat(relPath) {
    try {
      const head = await this.adapter.s3Client.send(
        new HeadObjectCommand({ Bucket: this.adapter.bucket, Key: this._key(relPath) })
      );
      return {
        size: head.ContentLength,
        mtime: head.LastModified,
      };
    } catch (err) {
      if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) return null;
      throw err;
    }
  }

  async delete(relPath) {
    try {
      await this.adapter.delete(this._key(relPath));
    } catch (err) {
      if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) return;
      throw err;
    }
  }

  async list(prefix) {
    const fullPrefix = this._key(prefix || '.');
    const entries = [];
    let continuationToken;
    do {
      const result = await this.adapter.list(fullPrefix, { continuationToken });
      for (const obj of result.Contents || []) {
        const stripped = this.prefix && obj.Key.startsWith(`${this.prefix}/`)
          ? obj.Key.slice(this.prefix.length + 1)
          : obj.Key;
        entries.push({ key: stripped, size: obj.Size, mtime: obj.LastModified });
      }
      continuationToken = result.NextContinuationToken;
    } while (continuationToken);
    return entries;
  }

  async copy(srcRelPath, dstRelPath) {
    await this.adapter.copy(this._key(srcRelPath), this._key(dstRelPath));
  }

  async rename(srcRelPath, dstRelPath) {
    await this.copy(srcRelPath, dstRelPath);
    await this.delete(srcRelPath);
  }

  async signedUrl(relPath, ttlSeconds = 300) {
    return this.adapter.getSignedUrl('getObject', this._key(relPath), { expiresIn: ttlSeconds });
  }

  // S3 has no local path; consumers that need one must use getToFile to a
  // temp location first. Returning null here makes the contract explicit so
  // legacy code using `storage.resolveLocalPath` fails fast instead of
  // silently constructing a bad path.
  resolveLocalPath(_relPath) {
    return null;
  }

  // Expose the underlying adapter so backupService keeps working.
  // New code should prefer the canonical interface above.
  get rawAdapter() {
    return this.adapter;
  }

  static fileStreamFromPath(localPath) {
    return fs.createReadStream(localPath);
  }
}

module.exports = S3StorageBackend;
