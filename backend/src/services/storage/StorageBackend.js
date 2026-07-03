/**
 * Storage backend interface that LocalFsStorage and S3Storage implement.
 *
 * All paths are POSIX-style relative keys under the deployment's storage root
 * (e.g. "events/active/wedding-smith/individual/IMG_0001.jpg"). Concrete adapters
 * resolve the absolute filesystem path or S3 key internally so callers never deal
 * with the difference between local and remote storage.
 *
 * Concurrency: methods are safe to call in parallel; ordering is the caller's
 * responsibility. `put` is best-effort atomic (LocalFs writes to a temp file
 * then renames; S3 returns only after the multipart upload is finalized).
 *
 * @typedef {Object} PutOptions
 * @property {string} [contentType] - MIME type stored in object metadata.
 * @property {string} [cacheControl] - Cache-Control header (S3 only).
 *
 * @typedef {Object} StatResult
 * @property {number} size - Size in bytes.
 * @property {Date} [mtime] - Last modified timestamp (best-effort; S3 uses LastModified).
 *
 * @typedef {Object} ListEntry
 * @property {string} key - Relative path under the storage root.
 * @property {number} size - Size in bytes.
 * @property {Date} [mtime] - Last modified timestamp.
 *
 * @typedef {Object} StorageBackend
 * @property {() => string} kind - Returns 'local' or 's3'.
 * @property {() => Promise<void>} init - Validates configuration and reachability. Called once at startup.
 * @property {(relPath: string, body: NodeJS.ReadableStream | Buffer, options?: PutOptions) => Promise<void>} put
 * @property {(relPath: string, localPath: string, options?: PutOptions) => Promise<void>} putFromFile
 * @property {(relPath: string) => Promise<NodeJS.ReadableStream>} get - Returns a readable stream of the object body.
 * @property {(relPath: string, start: number, end: number) => Promise<NodeJS.ReadableStream>} getRange - Returns a readable stream of the object body for the inclusive byte range [start, end]. Used by video range-request handlers.
 * @property {(relPath: string, localPath: string) => Promise<void>} getToFile - Streams the object to a local path (creates parent dirs).
 * @property {(relPath: string) => Promise<boolean>} exists
 * @property {(relPath: string) => Promise<StatResult|null>} stat - Null if missing.
 * @property {(relPath: string) => Promise<void>} delete - No-op if missing.
 * @property {(prefix: string) => Promise<ListEntry[]>} list
 * @property {(srcRelPath: string, dstRelPath: string) => Promise<void>} rename - Atomic on local fs; copy+delete on S3.
 * @property {(srcRelPath: string, dstRelPath: string) => Promise<void>} copy
 * @property {(relPath: string, ttlSeconds?: number) => Promise<string>} signedUrl - Presigned download URL (S3 only; LocalFs throws).
 */

module.exports = {};
