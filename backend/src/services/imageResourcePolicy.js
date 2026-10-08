const os = require('os');
const fs = require('fs');

const MiB = 1024 * 1024;
// sharp's own default limitInputPixels (0x3FFF squared): what every image
// path accepted before the isolated runner existed.
const SHARP_MAX_PIXELS = 268402689;
// Refusals that say "not now", never "not this image". Background work
// requeues on them; a request answers 503 with Retry-After.
const TRANSIENT = new Set(['IMAGE_QUEUE_FULL', 'IMAGE_TIMEOUT', 'IMAGE_CANCELLED', 'IMAGE_WORKER_UNAVAILABLE']);

function refusal(message, code = 'IMAGE_RESOURCE_LIMIT', detail) {
  return Object.assign(new Error(message), { code, status: TRANSIENT.has(code) ? 503 : 422 }, detail);
}
function positive(name, fallback, maximum) {
  const raw = process.env[name];
  const value = raw === undefined || raw === '' ? fallback : Number(raw);
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new Error(`Invalid ${name}`);
  }
  return value;
}
let memoryCache = null;
function effectiveMemory() {
  // Read on every submit otherwise; the cgroup files do not change that fast.
  if (memoryCache && Date.now() - memoryCache.at < 5000) return memoryCache.value;
  const limits = [os.totalmem()];
  if (typeof process.constrainedMemory === 'function') {
    const value = process.constrainedMemory();
    if (value > 0) limits.push(value);
  }
  for (const filename of ['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory/memory.limit_in_bytes']) {
    try {
      const value = Number(fs.readFileSync(filename, 'utf8').trim());
      if (Number.isSafeInteger(value) && value > 0) limits.push(value);
    } catch (_) { /* Bare metal or a different cgroup layout. */ }
  }
  memoryCache = { at: Date.now(), value: Math.min(...limits) };
  return memoryCache.value;
}
function configuration() {
  const memory = effectiveMemory();
  // The backend keeps at least half of its deployment memory. A worker gets a
  // quarter of it by default (768 MiB to 4 GiB) so a full-resolution transform
  // of a large camera file still fits; a small host keeps one worker.
  const configuredMemory = positive('IMAGE_WORKER_MEMORY_MIB', null, 16384);
  const nativeBytes = configuredMemory
    ? configuredMemory * MiB
    : Math.min(4096 * MiB, Math.max(768 * MiB, Math.floor(memory / 4 / MiB) * MiB));
  const workers = Math.max(1, Math.min(2, Math.floor(memory / 2 / nativeBytes)));
  const optionalMiB = (name, maximum) => {
    const value = positive(name, null, maximum);
    return value === null ? null : value * MiB;
  };
  return {
    nativeBytes, workers,
    // A job that runs out of memory in a shared worker is run once more on
    // its own with the whole image budget, unless the operator set the cap.
    exclusiveBytes: configuredMemory ? nativeBytes : Math.max(nativeBytes, Math.floor(memory / 2 / MiB) * MiB),
    maxPixels: positive('IMAGE_MAX_PIXELS', SHARP_MAX_PIXELS, SHARP_MAX_PIXELS),
    maxDimension: positive('IMAGE_MAX_DIMENSION', 65535, 65535),
    // Unset means "no limit of its own": the pixel limit already bounds every
    // image, and these three only reject on their own when an operator asks.
    maxFrames: positive('IMAGE_MAX_FRAMES', null, 100000),
    decodedBytes: optionalMiB('IMAGE_MAX_DECODED_MIB', 65536),
    inputBytes: optionalMiB('IMAGE_MAX_INPUT_MIB', 65536),
    outputBytes: 1024 * MiB,
    // Interactive callers are refused beyond this many waiting jobs;
    // background work waits instead.
    queueLength: positive('IMAGE_WORKER_QUEUE_LENGTH', 256, 4096),
    // Measured from the moment a job starts executing, not from submit.
    timeoutMs: positive('IMAGE_WORKER_TIMEOUT_MS', 120000, 3600000),
  };
}
const megapixels = pixels => Math.round(pixels / 1e5) / 10;
/**
 * Decoded size of the frames a job will actually read, from the real channel
 * count and bit depth. Throws a refusal naming the limit that was exceeded.
 * `frames` is 1 unless the caller opens every page (`animated: true`).
 */
function estimate(metadata, policy = configuration(), frames = 1) {
  const width = metadata.width;
  const height = metadata.pageHeight === undefined ? metadata.height : metadata.pageHeight;
  const channels = metadata.channels === undefined ? 3 : metadata.channels;
  const depth = { uchar: 1, char: 1, ushort: 2, short: 2, uint: 4, int: 4, float: 4, double: 8, complex: 8, dpcomplex: 16 }[metadata.depth || 'uchar'];
  if (![width, height, frames, channels].every(value => Number.isSafeInteger(value) && value > 0) || !depth) {
    throw refusal('Image dimensions could not be read');
  }
  if (width > policy.maxDimension || height > policy.maxDimension) {
    throw refusal(`Image is ${width} x ${height} px; this server processes images up to ${policy.maxDimension} px per side (IMAGE_MAX_DIMENSION)`,
      'IMAGE_RESOURCE_LIMIT', { imageLimit: 'dimension', imageMax: policy.maxDimension });
  }
  if (policy.maxFrames && frames > policy.maxFrames) {
    throw refusal(`Image has ${frames} frames; this server processes up to ${policy.maxFrames} frames (IMAGE_MAX_FRAMES)`,
      'IMAGE_RESOURCE_LIMIT', { imageLimit: 'frames', imageMax: policy.maxFrames });
  }
  const pixels = width * height * frames;
  if (pixels > policy.maxPixels) {
    throw refusal(`Image has ${megapixels(pixels)} megapixels; this server processes images up to ${megapixels(policy.maxPixels)} megapixels (IMAGE_MAX_PIXELS)`,
      'IMAGE_RESOURCE_LIMIT', { imageLimit: 'pixels', imageMax: megapixels(policy.maxPixels) });
  }
  const bytes = pixels * channels * depth;
  if (policy.decodedBytes && bytes > policy.decodedBytes) {
    throw refusal(`Image decodes to ${Math.ceil(bytes / MiB)} MiB; this server processes images up to ${policy.decodedBytes / MiB} MiB decoded (IMAGE_MAX_DECODED_MIB)`,
      'IMAGE_RESOURCE_LIMIT', { imageLimit: 'decoded', imageMax: policy.decodedBytes / MiB });
  }
  return bytes;
}
function isResourceError(error) {
  return typeof error?.code === 'string' && error.code.startsWith('IMAGE_');
}
function isTransient(error) {
  return TRANSIENT.has(error?.code);
}
/** Runs `work` again after a pause while the image worker says "not now". */
async function retryTransient(work, { attempts = 3, pauseMs = 2000 } = {}) {
  for (let attempt = 1; ; attempt++) {
    try { return await work(); }
    catch (error) {
      if (!isTransient(error) || attempt >= attempts) throw error;
      await new Promise(resolve => setTimeout(resolve, pauseMs));
    }
  }
}
/** The fields an upload response carries so the client can name the limit. */
function describe(error) {
  if (!isResourceError(error)) return {};
  return {
    code: error.code,
    ...(error.imageLimit ? { imageLimit: error.imageLimit, imageMax: error.imageMax } : {}),
  };
}
module.exports = { configuration, estimate, refusal, isResourceError, isTransient, retryTransient, describe, effectiveMemory, MiB };
