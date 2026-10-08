const os = require('os');
const fs = require('fs');

const MiB = 1024 * 1024;
function refusal(message, code = 'IMAGE_RESOURCE_LIMIT') {
  return Object.assign(new Error(message), { code, status: 422 });
}
function positive(name, fallback, maximum) {
  const raw = process.env[name];
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new Error(`Invalid ${name}`);
  }
  return value;
}
function effectiveMemory() {
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
  return Math.min(...limits);
}
function configuration() {
  const memory = effectiveMemory();
  // The backend keeps at least half of its deployment memory. Operators may
  // lower these limits, but cannot turn off the native child cap or exceed it.
  const nativeBytes = positive('IMAGE_WORKER_MEMORY_MIB', 512, 4096) * MiB;
  const available = Math.floor(memory / 2);
  const workers = Math.min(2, Math.floor(available / nativeBytes));
  const decodedBytes = positive('IMAGE_MAX_DECODED_MIB', 256, 2048) * MiB;
  if (decodedBytes > nativeBytes / 2) throw new Error('IMAGE_MAX_DECODED_MIB exceeds the worker memory budget');
  return {
    nativeBytes, workers, decodedBytes,
    maxPixels: Math.min(positive('IMAGE_MAX_PIXELS', 40000000, 268402689), Math.floor(decodedBytes / 4)),
    maxDimension: positive('IMAGE_MAX_DIMENSION', 16384, 65535), maxFrames: positive('IMAGE_MAX_FRAMES', 128, 1024),
    inputBytes: Math.min(positive('IMAGE_MAX_INPUT_MIB', 96, 512) * MiB, nativeBytes / 4),
    outputBytes: Math.min(64 * MiB, nativeBytes / 8),
    queueLength: positive('IMAGE_WORKER_QUEUE_LENGTH', 32, 128),
    timeoutMs: positive('IMAGE_WORKER_TIMEOUT_MS', 30000, 120000),
    batchBytes: Math.min(512 * MiB, available),
    eventBytes: Math.min(1024 * MiB, available),
    deploymentBytes: Math.min(2048 * MiB, available * 2),
  };
}
function estimate(metadata, policy = configuration()) {
  const width = metadata.width;
  const pages = metadata.pages === undefined ? 1 : metadata.pages;
  const height = metadata.pageHeight === undefined ? metadata.height : metadata.pageHeight;
  const sourceChannels = metadata.channels === undefined ? 4 : metadata.channels;
  if (!Number.isSafeInteger(sourceChannels) || sourceChannels <= 0) throw refusal('Invalid image channels');
  const channels = Math.max(4, sourceChannels);
  const depth = { uchar: 1, char: 1, ushort: 2, short: 2, uint: 4, int: 4, float: 4, double: 8, complex: 8, dpcomplex: 16 }[metadata.depth || 'uchar'];
  if (![width, height, pages, channels].every(value => Number.isSafeInteger(value) && value > 0) || !depth ||
      width > policy.maxDimension || height > policy.maxDimension || pages > policy.maxFrames) {
    throw refusal('Image dimensions, frame count or depth exceed the processing budget');
  }
  const pixels = width * height * pages;
  const bytes = pixels * channels * depth;
  if (!Number.isSafeInteger(bytes) || pixels > policy.maxPixels || bytes > policy.decodedBytes) {
    throw refusal('Image decoded size exceeds the processing budget');
  }
  return bytes;
}
function isResourceError(error) {
  return typeof error?.code === 'string' && error.code.startsWith('IMAGE_');
}
module.exports = { configuration, estimate, refusal, isResourceError, effectiveMemory };
