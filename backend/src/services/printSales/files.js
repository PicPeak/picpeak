'use strict';
const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { Readable, Transform, Writable } = require('stream');
const { pipeline, finished } = require('stream/promises');
const { AppError, ConflictError } = require('../../utils/errors');

const IDLE_MS = 60000;

/** Lazy, bounded reads work for both local files and S3 without retaining a file. */
function verifiedStream(storage, asset) {
  return Readable.from((async function* () {
    if (!Number.isSafeInteger(Number(asset.size)) || Number(asset.size) < 0)
      throw new ConflictError('Invalid production file size');
    const source = await storage.get(asset.storage_key), hash = crypto.createHash('sha256');
    let size = 0;
    const timer = setTimeout(() => source.destroy(new AppError('Order file read timed out', 504)), IDLE_MS);
    timer.unref();
    try {
      for await (const chunk of source) {
        timer.refresh(); size += chunk.length;
        if (size > Number(asset.size)) throw new ConflictError('An order file changed; hold the order for review');
        hash.update(chunk);
        yield chunk;
      }
      if (size !== Number(asset.size) || hash.digest('hex') !== asset.sha256)
        throw new ConflictError('An order file changed; hold the order for review');
    } finally { clearTimeout(timer); source.destroy(); }
  })(), { objectMode: false });
}

async function verify(storage, asset, options = {}) {
  await pipeline(verifiedStream(storage, asset), new Writable({ write(_chunk, _encoding, done) { done(); } }), options);
}

/** Publish the asset row only after the entire upload and its digest finish. */
async function upload(storage, key, body, maxBytes, options) {
  const source = Buffer.isBuffer(body) ? Readable.from(body) : body;
  const hash = crypto.createHash('sha256'); let size = 0;
  const meter = new Transform({ transform(chunk, _encoding, done) {
    size += chunk.length;
    if (size > maxBytes) return done(new AppError('Production file exceeds the order file limit', 400));
    hash.update(chunk); done(null, chunk);
  } });
  const pending = [];
  try {
    pending.push(pipeline(source, meter), storage.put(key, meter, options));
    await Promise.all(pending);
    return { size, sha256: hash.digest('hex') };
  } catch (error) {
    source.destroy(); meter.destroy();
    await Promise.allSettled(pending);
    await storage.delete(key).catch(() => {});
    throw error;
  }
}

let downloads = 0;
/** Verify into a private file before releasing a single byte to the browser. */
async function withVerifiedFile(storage, asset, consume, { signal } = {}) {
  if (downloads >= 2) throw new AppError('Two print downloads are already in progress; try again shortly', 503);
  downloads++;
  let dir, stream;
  try {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'picpeak-print-download-'));
    const file = path.join(dir, 'verified');
    await pipeline(verifiedStream(storage, asset), fs.createWriteStream(file, { flags: 'wx', mode: 0o600 }), { signal });
    stream = fs.createReadStream(file);
    return await consume(stream, Number(asset.size));
  } finally {
    try {
      if (stream) { stream.destroy(); await finished(stream).catch(() => {}); }
      if (dir) await fsp.rm(dir, { recursive: true, force: true });
    } finally { downloads--; }
  }
}

module.exports = { verifiedStream, verify, upload, withVerifiedFile };
