const path = require('path');
const fs = require('fs');
const fsp = require('fs').promises;
const crypto = require('crypto');
const { HeadObjectCommand } = require('@aws-sdk/client-s3');

const S3StorageAdapter = require('./s3Storage');
const logger = require('../../utils/logger');
const generationIndex = require('./generationIndex');

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
    if (this.prefix) generationIndex.logicalKey(this.prefix);
    this.namespace = crypto.createHash('sha256').update(JSON.stringify([
      config.endpoint ? new URL(config.endpoint.includes('://') ? config.endpoint : `${config.sslEnabled === false ? 'http' : 'https'}://${config.endpoint}`).href : null,
      config.region || 'us-east-1', config.bucket, this.prefix,
    ])).digest('hex');
    this.indexDatabase = config.indexDatabase; // Explicit isolated test DBs.
    this.mapping = new Map();
    this.revision = null;
    this.indexLoaded = false;
  }

  kind() {
    return 's3';
  }

  _key(relPath) {
    this._assertIndexLoaded();
    generationIndex.logicalKey(relPath, { prefix: this.prefix });
    return this._physicalKey(this.mapping.get(relPath) || relPath);
  }

  _physicalKey(key) { return this.prefix ? `${this.prefix}/${key}` : key; }

  _assertIndexLoaded() {
    if (!this.indexLoaded) throw new Error('S3 generation index has not been initialized');
  }

  async init() {
    this.indexLoaded = false;
    const database = this.indexDatabase || require('../../database/db').db;
    const loaded = generationIndex.validateRows(await generationIndex.readRows(database), this.namespace, this.prefix);
    await this.adapter.testConnection();
    this.mapping = loaded.mapping;
    this.revision = loaded.revision;
    this.indexLoaded = true;
    logger.info(`[storage] S3StorageBackend initialized bucket=${this.adapter.bucket} prefix=${this.prefix || '(none)'}`);
  }

  async put(relPath, body, options = {}) {
    const key = this._key(relPath);
    if (Buffer.isBuffer(body)) {
      const { Readable } = require('stream');
      const stream = Readable.from(body);
      await this.adapter.uploadStream(stream, key, {
        contentType: options.contentType,
        contentDisposition: options.contentDisposition,
        cacheControl: options.cacheControl,
        metadata: options.metadata,
      });
      return;
    }
    if (body && typeof body.pipe === 'function') {
      await this.adapter.uploadStream(body, key, {
        contentType: options.contentType,
        contentDisposition: options.contentDisposition,
        cacheControl: options.cacheControl,
        metadata: options.metadata,
      });
      return;
    }
    throw new Error('S3StorageBackend.put: body must be a Buffer or Readable stream');
  }

  async putFromFile(relPath, localPath, options = {}) {
    await this.adapter.upload(localPath, this._key(relPath), {
      contentType: options.contentType,
      contentDisposition: options.contentDisposition,
      cacheControl: options.cacheControl,
      metadata: options.metadata,
    });
  }

  async get(relPath, options = {}) {
    return this.adapter.downloadStream(this._key(relPath), { ifMatch: options.ifMatch, versionId: options.versionId });
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
        contentType: head.ContentType,
        contentDisposition: head.ContentDisposition,
        cacheControl: head.CacheControl,
        metadata: head.Metadata,
        etag: head.ETag,
        versionId: head.VersionId,
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
    this._assertIndexLoaded();
    const rootList = !prefix || prefix === '.';
    if (!rootList) generationIndex.logicalKey(prefix, { prefix: this.prefix, listing: true });
    const fullPrefix = rootList ? (this.prefix ? `${this.prefix}/` : '') : this._physicalKey(prefix);
    const entries = await this._listPhysical(fullPrefix);
    const selected = key => rootList || key.startsWith(prefix);
    const visible = entries.filter(entry => !entry.key.startsWith(`${generationIndex.INTERNAL_ROOT}/`)
      && entry.key !== generationIndex.INTERNAL_ROOT && !this.mapping.has(entry.key) && selected(entry.key));
    if (this.mapping.size) {
      const reverse = new Map([...this.mapping].filter(([logical]) => selected(logical)).map(([logical, physical]) => [physical, logical]));
      if (reverse.size) {
        const staged = await this._listPhysical(this._physicalKey(`${generationIndex.INTERNAL_ROOT}/`));
        for (const entry of staged) {
          const logical = reverse.get(entry.key);
          if (logical) visible.push({ ...entry, key: logical });
        }
      }
    }
    return visible;
  }

  async _listPhysical(fullPrefix) {
    const entries = [];
    const tokens = new Set();
    let continuationToken;
    do {
      const result = await this.adapter.list(fullPrefix, { continuationToken });
      for (const obj of result.Contents || []) {
        if (this.prefix && !obj.Key.startsWith(`${this.prefix}/`)) continue;
        const stripped = this.prefix && obj.Key.startsWith(`${this.prefix}/`)
          ? obj.Key.slice(this.prefix.length + 1)
          : obj.Key;
        entries.push({ key: stripped, size: obj.Size, mtime: obj.LastModified });
      }
      continuationToken = result.NextContinuationToken;
      if (result.IsTruncated && !continuationToken) throw new Error('S3 object listing was truncated without a continuation token');
      if (continuationToken) {
        if (typeof continuationToken !== 'string' || tokens.has(continuationToken)) throw new Error('S3 object listing has an invalid/repeated continuation token');
        tokens.add(continuationToken);
      }
    } while (continuationToken);
    return entries;
  }

  /**
   * Stage an EXACT restore plan. Each write has its own opaque physical key,
   * so even a failed request that finishes remotely later cannot replace old
   * bytes or a successful retry. Only publish(trx) exposes completed keys.
   * Cache activation is deliberately absent: all replicas must restart after
   * the enclosing restore transaction commits, before resuming any work.
   */
  createRestoreGeneration(attemptId, expectedKeys) {
    this._assertIndexLoaded();
    if (!generationIndex.ATTEMPT.test(attemptId) || !Array.isArray(expectedKeys)
        || expectedKeys.length > generationIndex.MAX_ENTRIES) throw new Error('Invalid S3 restore generation plan');
    const expected = new Set();
    let planBytes = 64;
    for (const key of expectedKeys) {
      generationIndex.logicalKey(key, { prefix: this.prefix });
      planBytes += Buffer.byteLength(JSON.stringify(key)) + 256;
      if (planBytes > generationIndex.MAX_ENCODED_BYTES) throw new Error('S3 restore plan exceeds its byte limit');
      expected.add(key);
    }
    if (expected.size !== expectedKeys.length) throw new Error('Duplicate S3 restore generation key');
    const baseMapping = new Map(this.mapping);
    const baseRevision = this.revision;
    const publishRevision = crypto.randomUUID();
    const thisNamespace = this.namespace;
    const thisPrefix = this.prefix;
    const completed = new Map();
    const verified = new Map();
    const writes = [];
    const pendingKeys = new Set();
    let verifiedBytes = 0;
    let pending = 0;
    let publishing = false;
    const staged = Object.create(this);
    staged.mapping = new Map(baseMapping);
    staged._key = key => {
      if (expected.has(key) && !completed.has(key)) throw new Error('S3 restore object is not staged');
      return S3StorageBackend.prototype._key.call(staged, key);
    };
    const write = async (key, operation) => {
      generationIndex.logicalKey(key, { prefix: this.prefix });
      if (publishing || !expected.has(key)) throw new Error('S3 restore write is outside the frozen plan');
      if (pendingKeys.has(key)) throw new Error('Concurrent S3 stage writes to one logical key are forbidden');
      if (writes.length >= generationIndex.MAX_ENTRIES * 2) throw new Error('S3 restore generation exceeds its write limit');
      const physical = `${generationIndex.INTERNAL_ROOT}/${attemptId}/${crypto.randomUUID()}`;
      if (Buffer.byteLength(this._physicalKey(physical)) > 1024) throw new Error('S3 staging key exceeds 1024 bytes');
      pending += 1;
      pendingKeys.add(key);
      const record = { logical: key, physical, status: 'in-flight' };
      writes.push(record);
      try {
        await operation(this._physicalKey(physical));
        completed.set(key, physical);
        if (verified.has(key)) verifiedBytes -= Buffer.byteLength(JSON.stringify(verified.get(key)));
        verified.delete(key);
        staged.mapping.set(key, physical);
        record.status = 'completed';
      } catch (error) {
        record.status = 'uncertain'; // A remote write may still finish later.
        throw error;
      } finally { pending -= 1; pendingKeys.delete(key); }
    };
    staged.put = (key, body, options = {}) => write(key, async physical => {
      if (!Buffer.isBuffer(body) && !(body && typeof body.pipe === 'function')) throw new Error('Invalid S3 staging body');
      const { Readable } = require('stream');
      await this.adapter.uploadStream(Buffer.isBuffer(body) ? Readable.from(body) : body, physical, options);
    });
    staged.putFromFile = (key, file, options = {}) => write(key, physical => this.adapter.upload(file, physical, options));
    for (const method of ['delete', 'copy', 'rename', 'signedUrl', 'createRestoreGeneration', 'init']) {
      staged[method] = async () => { throw new Error('Unsupported operation on S3 restore staging storage'); };
    }
    return {
      id: attemptId,
      storage: staged,
      stagedKeys: () => [...completed.keys()],
      recordVerified(key, evidence) {
        if (publishing || pendingKeys.has(key) || !completed.has(key) || !evidence || !/^[a-f0-9]{64}$/.test(evidence.checksum)
            || !Number.isSafeInteger(evidence.size) || evidence.size < 0) throw new Error('Invalid verified S3 stage evidence');
        // Use the same header/custom-metadata validation as recovery capture.
        const metadata = require('../recoveryFiles').objectOptions(evidence.object_metadata);
        const record = { logical: key, physical: completed.get(key), checksum: evidence.checksum,
          size: evidence.size, object_metadata: metadata };
        const bytes = Buffer.byteLength(JSON.stringify(record));
        const previousBytes = verified.has(key) ? Buffer.byteLength(JSON.stringify(verified.get(key))) : 0;
        if (bytes > 16384 || verifiedBytes - previousBytes + bytes > generationIndex.MAX_ENCODED_BYTES) {
          throw new Error('S3 stage evidence exceeds its metadata limit');
        }
        verifiedBytes = verifiedBytes - previousBytes + bytes;
        verified.set(key, record);
      },
      manifest() {
        const result = { version: 1, id: attemptId, namespace: thisNamespace, baseRevision, revision: publishRevision,
          files: [...verified.values()], writes: writes.map(record => ({ ...record })) };
        const encoded = JSON.stringify(result);
        if (Buffer.byteLength(encoded) > generationIndex.MAX_ENCODED_BYTES) throw new Error('S3 stage manifest exceeds its byte limit');
        return JSON.parse(encoded);
      },
      async publish(trx) {
        if (!trx?.isTransaction) throw new Error('S3 generation publication requires the restore transaction');
        if (publishing || pending || completed.size !== expected.size || verified.size !== expected.size) {
          throw new Error('S3 restore generation is incomplete, unverified or already frozen');
        }
        publishing = true;
        const current = generationIndex.validateRows(await generationIndex.readRows(trx), thisNamespace, thisPrefix);
        if (current.revision !== baseRevision) throw new Error('S3 generation changed while restore was staged');
        const merged = new Map([...baseMapping, ...completed]);
        const rows = generationIndex.encodeRows(thisNamespace, merged, publishRevision);
        generationIndex.validateRows(rows, thisNamespace, thisPrefix);
        if (baseRevision) {
          // CAS also protects a second transaction that read the old revision
          // before this transaction committed (including PostgreSQL replicas).
          const changed = await trx(generationIndex.TABLE).where({ id: 1, namespace: thisNamespace, revision: baseRevision }).update(rows[0]);
          if (changed !== 1) throw new Error('S3 generation changed during publication');
        } else {
          // The singleton PK arbitrates concurrent first publications.
          await trx(generationIndex.TABLE).insert(rows);
        }
        return { revision: rows[0].revision, stagedKeys: completed.size };
      },
    };
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

  static fileStreamFromPath(localPath) {
    return fs.createReadStream(localPath);
  }
}

module.exports = S3StorageBackend;
