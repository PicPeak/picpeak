'use strict';
const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { Readable, Transform, Writable } = require('stream');
const { pipeline, finished } = require('stream/promises');
const { AppError, ConflictError } = require('../../utils/errors');

const IDLE_MS = 60000, TEMP_LEASE_MS = 15000, TEMP_STALE_MS = 5 * 60e3;
const activeDirectories = new Set();
const damaged = message => Object.assign(new ConflictError(message), { code: 'PRINT_FILES_DAMAGED' });
const missing = error => ['ENOENT', 'NoSuchKey', 'NotFound'].includes(error.code || error.name) || error.$metadata?.httpStatusCode === 404;

/** The source clock is stopped while downstream applies backpressure. */
function verifiedStream(storage, asset, { signal, idleMs = IDLE_MS } = {}) {
  return Readable.from((async function* () {
    signal?.throwIfAborted();
    if (!Number.isSafeInteger(Number(asset.size)) || Number(asset.size) < 0) throw damaged('Invalid production file size');
    let source;
    try { source = await storage.get(asset.storage_key, { signal }); }
    catch (error) { if (missing(error)) throw damaged('A production file is missing'); throw error; }
    const abort = () => source.destroy(signal.reason), iterator = source[Symbol.asyncIterator](), hash = crypto.createHash('sha256');
    signal?.addEventListener('abort', abort, { once: true });
    let size = 0, timer;
    try {
      signal?.throwIfAborted();
      while (true) {
        timer = setTimeout(() => source.destroy(new AppError('Order file read timed out', 504)), idleMs); timer.unref();
        let next;
        try { next = await iterator.next(); } finally { clearTimeout(timer); }
        if (next.done) break;
        const chunk = next.value; size += chunk.length;
        if (size > Number(asset.size)) throw damaged('An order file changed; hold the order for review');
        hash.update(chunk); yield chunk;
      }
      if (size !== Number(asset.size) || hash.digest('hex') !== asset.sha256)
        throw damaged('An order file changed; hold the order for review');
    } catch (error) {
      if (missing(error)) throw damaged('A production file is missing');
      throw error;
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); source.destroy(); }
  })(), { objectMode: false });
}
async function verify(storage, asset, options = {}) {
  await pipeline(verifiedStream(storage, asset, options), new Writable({ write(_chunk, _encoding, done) { done(); } }), { signal: options.signal });
}

/** The storage adapter and the producer settle before an aborted upload returns. */
async function upload(storage, key, body, maxBytes, options = {}) {
  const source = Buffer.isBuffer(body) ? Readable.from(body) : body;
  const hash = crypto.createHash('sha256'); let size = 0;
  const meter = new Transform({ transform(chunk, _encoding, done) {
    size += chunk.length;
    if (size > maxBytes) return done(new AppError('Production file exceeds the order file limit', 400));
    hash.update(chunk); done(null, chunk);
  } });
  const pending = [];
  try {
    pending.push(pipeline(source, meter, { signal: options.signal }), storage.put(key, meter, options));
    await Promise.all(pending);
    options.signal?.throwIfAborted();
    return { size, sha256: hash.digest('hex') };
  } catch (error) {
    source.destroy(); meter.destroy();
    await Promise.allSettled(pending);
    await storage.delete(key).catch(() => {});
    throw error;
  }
}

let downloads = 0;
async function withFileWork(run) {
  if (downloads >= 2) throw new AppError('Two print file operations are already in progress; try again shortly', 503);
  downloads++;
  try { return await run(); } finally { downloads--; }
}
/** A lease distinguishes an abandoned copy from another process's slow download. */
async function sweepDownloads({ directory = os.tmpdir(), at = Date.now(), staleMs = TEMP_STALE_MS } = {}) {
  for (const name of await fsp.readdir(directory)) {
    if (!/^picpeak-print-download-[a-zA-Z0-9]{6}$/.test(name)) continue;
    const dir = path.join(directory, name);
    if (activeDirectories.has(dir)) continue;
    try {
      const stat = await fsp.lstat(dir);
      if (stat.isDirectory() && (typeof process.getuid !== 'function' || stat.uid === process.getuid()) && at - stat.mtimeMs > staleMs)
        await fsp.rm(dir, { recursive: true, force: true });
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
/** Verify the requested file once, into a private copy, before browser release. */
async function withVerifiedFile(storage, asset, consume, { signal, directory = os.tmpdir() } = {}) {
  return withFileWork(async () => {
    let dir, stream, timer, heartbeat = Promise.resolve();
    try {
      dir = await fsp.mkdtemp(path.join(directory, 'picpeak-print-download-')); activeDirectories.add(dir);
      timer = setInterval(() => { heartbeat = heartbeat.then(() => fsp.utimes(dir, new Date(), new Date())).catch(() => {}); }, TEMP_LEASE_MS); timer.unref();
      const file = path.join(dir, 'verified');
      await pipeline(verifiedStream(storage, asset, { signal }), fs.createWriteStream(file, { flags: 'wx', mode: 0o600 }), { signal });
      stream = fs.createReadStream(file);
      return await consume(stream, Number(asset.size));
    } finally {
      clearInterval(timer); await heartbeat;
      try {
        if (stream) { stream.destroy(); await finished(stream).catch(() => {}); }
        if (dir) await fsp.rm(dir, { recursive: true, force: true });
      } finally { if (dir) activeDirectories.delete(dir); }
    }
  });
}
module.exports = { verifiedStream, verify, upload, withVerifiedFile, withFileWork, sweepDownloads, damaged };
