// HTTP chunk uploads keep one persistent admission from init through the last
// processing side effect. Legacy non-HTTP callers of chunkedUploadService do
// not opt in. No body is consumed before the per-session gate and rate claim.
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const quota = require('./publicUploadQuota');
const { createUploadFileGuard } = require('../utils/uploadAdmissionType');

const error = (message, statusCode, code = 'UPLOAD_STATE') => Object.assign(new Error(message), { statusCode, code });
const cancelled = () => error('Upload cancelled', 400, 'UPLOAD_CANCELLED');
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

async function exclusive(meta, work) {
  if (meta.cancelled) throw cancelled();
  if (meta.busy) throw error('Upload is busy', 409);
  // Synchronous before the first await: overlapping retries cannot each open
  // their own .part, nor can completion race a writer's publish.
  const busy = deferred();
  meta.busy = busy.promise;
  meta.controller = new AbortController();
  try {
    return await work(meta.controller.signal);
  } finally {
    meta.controller = null;
    meta.busy = null;
    busy.resolve();
  }
}

// Unlike pipeline(IncomingMessage, ...), refusal pauses rather than destroys
// the request's socket, so the route can send its JSON error. All outcomes wait
// for the actual file descriptor close, including a pending open().
function writePart(source, destination, allowance, { signal, deadlineMs, guard, count }) {
  return new Promise((resolve, reject) => {
    if (source.destroyed || source.aborted || source.readableEnded) return reject(error('Request body closed before the chunk was fully received', 400));
    const out = fsSync.createWriteStream(destination, { flags: 'wx', mode: 0o600 });
    let settled = false;
    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      source.removeListener('data', onData);
      source.removeListener('error', onError);
      source.removeListener('aborted', onAbortBody);
      source.removeListener('close', onClose);
    };
    const settle = err => {
      if (settled) return;
      settled = true;
      source.unpipe(guard || out);
      if (err) source.pause();
      if (guard) { guard.unpipe(out); guard.destroy(); }
      const closed = () => { cleanup(); if (err) reject(err); else resolve(count.bytes); };
      if (out.closed) closed();
      else { out.once('close', closed); if (err) out.destroy(); }
    };
    const onError = err => settle(err);
    const onAbort = () => settle(cancelled());
    const onAbortBody = () => settle(error('Request body closed before the chunk was fully received', 400));
    const onClose = () => { if (!source.readableEnded) onAbortBody(); };
    const onData = bytes => {
      count.bytes += bytes.length;
      if (count.bytes > allowance) settle(error(`Chunk must be ${allowance} bytes`, 400, 'INVALID_CHUNK'));
    };
    source.on('data', onData);
    source.on('error', onError);
    source.on('aborted', onAbortBody);
    source.on('close', onClose);
    out.on('error', onError);
    out.on('finish', () => settle());
    guard?.on('error', onError);
    signal.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => settle(error('Upload request timed out', 408, 'UPLOAD_REQUEST_TIMEOUT')), deadlineMs);
    timer.unref?.();
    if (signal.aborted) return onAbort();
    if (guard) source.pipe(guard).pipe(out); else source.pipe(out);
  });
}

async function cleanupAttempt(meta, part, ingress, count) {
  try {
    await fs.rm(part, { force: true });
    await quota.settleChunkIngress(ingress, count.bytes);
  } catch (err) {
    meta.status = 'failed';
    throw err;
  }
}

async function upload(meta, index, source, declaredBytes, chunkSize) {
  if (!Number.isSafeInteger(index) || index < 0 || index >= meta.expectedChunks) throw error('Invalid chunk index', 400, 'INVALID_CHUNK');
  const expected = index < meta.expectedChunks - 1 ? chunkSize : meta.fileSize - index * chunkSize;
  if (Number.isFinite(declaredBytes) && declaredBytes !== expected) throw error(`Chunk ${index} must be ${expected} bytes`, 400, 'INVALID_CHUNK');
  if (Buffer.isBuffer(source) && source.length !== expected) throw error(`Chunk ${index} must be ${expected} bytes`, 400, 'INVALID_CHUNK');
  const video = meta.mimeType.startsWith('video/');
  if (video && !meta.videoValidated && index !== 0) throw error('Upload video chunk 0 first', 409);
  return exclusive(meta, async signal => {
    const ingress = await quota.reserveChunkIngress(meta.admission, expected);
    const count = { bytes: 0 };
    // Serialized attempts use one bounded, exclusive pathname. A cleanup
    // failure makes the session non-retryable instead of accumulating parts.
    const part = path.join(meta.uploadDir, 'incoming.part');
    const destination = path.join(meta.uploadDir, `chunk_${String(index).padStart(6, '0')}`);
    try {
      if (signal.aborted) throw cancelled();
      const guard = video && index === 0
        ? createUploadFileGuard({ mimetype: meta.mimeType }, meta.maxFileSizeBytes, meta.maxFileSizeBytes) : null;
      await writePart(Buffer.isBuffer(source) ? Readable.from([source]) : source, part, expected, {
        signal, deadlineMs: meta.admission.limits.requestTimeoutMs, guard, count,
      });
      if (count.bytes !== expected) throw error(`Chunk ${index} must be ${expected} bytes`, 400, 'INVALID_CHUNK');
      if (signal.aborted) throw cancelled();
      await fs.rename(part, destination);
      meta.receivedChunks.add(index);
      meta.chunkSizes.set(index, count.bytes);
      if (video && index === 0) meta.videoValidated = true;
      let banked = 0;
      for (const size of meta.chunkSizes.values()) banked += size;
      await quota.stagedChunks(meta.admission, banked, meta.receivedChunks.size + 1);
      return { chunkIndex: index, received: meta.receivedChunks.size, expected: meta.expectedChunks,
        progress: meta.receivedChunks.size / meta.expectedChunks * 100,
        complete: meta.receivedChunks.size === meta.expectedChunks };
    } finally {
      await cleanupAttempt(meta, part, ingress, count);
    }
  });
}

async function complete(meta) {
  if (meta.receivedChunks.size !== meta.expectedChunks) throw error(`Missing chunks: received ${meta.receivedChunks.size} of ${meta.expectedChunks}`, 400);
  return exclusive(meta, async signal => {
    meta.status = 'merging';
    const tempDir = path.join(meta.admission.dir, 'merged');
    const mergedPath = path.join(tempDir, meta.filename);
    try {
      await quota.prepareChunkMerge(meta.admission);
      if (signal.aborted) throw cancelled();
      await fs.mkdir(tempDir, { mode: 0o700 });
      for (let index = 0; index < meta.expectedChunks; index++) {
        await pipeline(fsSync.createReadStream(path.join(meta.uploadDir, `chunk_${String(index).padStart(6, '0')}`)),
          fsSync.createWriteStream(mergedPath, { flags: index === 0 ? 'wx' : 'a', mode: 0o600 }), { signal });
      }
      const stats = await fs.stat(mergedPath);
      if (stats.size !== meta.fileSize || stats.size > meta.maxFileSizeBytes) throw error('Invalid merged file size', 400, 'INVALID_CHUNK');
      if (signal.aborted) throw cancelled();
      await fs.rm(meta.uploadDir, { recursive: true, force: true });
      await quota.staged(meta.admission, stats.size, 1);
      // Installed before releasing the merge gate. Abort in the route handoff
      // must also wait for the processor, not just the merge's descriptor.
      meta.processing = deferred();
      meta.status = 'processing';
      return { path: mergedPath, filename: meta.filename, size: stats.size, mimeType: meta.mimeType,
        eventId: meta.eventId, tempDir, uploadReservation: meta.admission };
    } catch (err) {
      meta.status = 'failed';
      throw err;
    }
  });
}

async function abort(meta) {
  meta.cancelled = true;
  meta.controller?.abort();
  await meta.busy;
  await meta.processing?.promise;
  if (!(await quota.finish(meta.admission))) throw error('Upload cleanup unavailable', 503, 'UPLOAD_CLEANUP_UNAVAILABLE');
}

function processingSettled(meta) {
  meta.processing?.resolve();
  meta.processing = null;
}

module.exports = { upload, complete, abort, processingSettled };
