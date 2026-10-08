const { configuration: imageConfiguration, effectiveMemory } = require('./imageResourcePolicy');
const MiB = 1024 * 1024;
function refusal(message, code = 'MEDIA_RESOURCE_LIMIT') { return Object.assign(new Error(message), { code, status: 422 }); }
function positive(name, fallback, maximum) {
  const value = process.env[name] === undefined ? fallback : Number(process.env[name]);
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) throw new Error(`Invalid ${name}`);
  return value;
}
function configuration() {
  const image = imageConfiguration();
  const nativeBytes = positive('MEDIA_WORKER_MEMORY_MIB', 768, 4096) * MiB;
  const decodedBytes = Math.min(image.decodedBytes, nativeBytes / 2);
  return { nativeBytes, decodedBytes,
    inputBytes: positive('MEDIA_MAX_INPUT_MIB', 512, 10240) * MiB,
    snapshotBytes: Math.min(positive('MEDIA_MAX_SNAPSHOT_MIB', 1024, 20480) * MiB, Math.floor(effectiveMemory() / 2)),
    outputBytes: positive('MEDIA_MAX_VIDEO_OUTPUT_MIB', 512, 10240) * MiB,
    maxPixels: Math.min(positive('MEDIA_MAX_VIDEO_PIXELS', 40000000, 268402689), Math.floor(decodedBytes / 8)),
    maxDimension: positive('MEDIA_MAX_VIDEO_DIMENSION', 16384, 65535),
    maxStreams: positive('MEDIA_MAX_VIDEO_STREAMS', 16, 64),
    maxDuration: positive('MEDIA_MAX_VIDEO_DURATION_SECONDS', 7200, 86400),
    maxFps: positive('MEDIA_MAX_VIDEO_FPS', 240, 1000),
    maxWork: positive('MEDIA_MAX_VIDEO_PIXEL_FRAMES', 2000000000000, 20000000000000),
    probeMs: positive('MEDIA_PROBE_TIMEOUT_MS', 30000, 120000),
    rawMs: positive('MEDIA_RAW_TIMEOUT_MS', 30000, 120000),
    thumbnailMs: positive('MEDIA_THUMBNAIL_TIMEOUT_MS', 60000, 300000),
    renditionMs: positive('VIDEO_RENDITION_TIMEOUT_MS', 3600000, 7200000),
    rawOutputBytes: 64 * MiB,
  };
}
function numeric(value, label, { zero = false } = {}) {
  if (value === undefined || value === null || value === 'N/A') return null;
  const result = Number(value);
  if (!Number.isFinite(result) || result < 0 || (!zero && result === 0)) throw refusal(`Invalid video ${label}`);
  return result;
}
function rate(value) {
  if (value === undefined || value === 'N/A' || value === '0/0' || value === '0/1') return null;
  const pieces = String(value).split('/');
  const result = pieces.length === 2 ? Number(pieces[0]) / Number(pieces[1]) : Number(value);
  if (!Number.isFinite(result) || result <= 0) throw refusal('Invalid video frame rate');
  return result;
}
function estimate(metadata, policy = configuration()) {
  if (!Array.isArray(metadata.streams) || metadata.streams.length > policy.maxStreams) throw refusal('Video stream count exceeds the processing budget');
  const formats = String(metadata.format?.format_name || '').split(',');
  const supported = new Set(['mov', 'mp4', 'm4a', '3gp', '3g2', 'mj2', 'matroska', 'webm', 'avi', 'mpeg', 'mpegvideo', 'mpegts', 'ogg']);
  if (!formats.length || !formats.every(format => supported.has(format))) throw refusal('Unsupported video container', 'MEDIA_INVALID_SIGNATURE');
  const duration = numeric(metadata.format?.duration, 'duration', { zero: true });
  if (duration !== null && duration > policy.maxDuration) throw refusal('Video duration exceeds the processing budget');
  let decodedBytes = 0, work = 0;
  const videos = metadata.streams.filter(stream => stream.codec_type === 'video');
  if (!videos.length) throw refusal('Video has no video stream', 'MEDIA_INVALID_SIGNATURE');
  for (const stream of videos) {
    const width = numeric(stream.width, 'width'), height = numeric(stream.height, 'height');
    const fps = rate(stream.avg_frame_rate) || rate(stream.r_frame_rate) || 120;
    const frames = numeric(stream.nb_frames, 'frame count', { zero: true });
    if (fps > policy.maxFps) throw refusal('Video frame rate exceeds the processing budget');
    if (width === null || height === null) { decodedBytes += policy.decodedBytes; work += policy.maxWork; continue; }
    if (![width, height].every(Number.isSafeInteger) || width > policy.maxDimension || height > policy.maxDimension || width * height > policy.maxPixels) throw refusal('Video dimensions exceed the processing budget');
    // Decoder reference frames/filter intermediates, not only compressed bytes.
    const hdr = /(?:10|12|14|16)(?:le|be)?$/.test(stream.pix_fmt || '') || ['smpte2084', 'arib-std-b67'].includes(stream.color_transfer);
    decodedBytes += width * height * (hdr ? 16 : 8);
    work += duration === null && frames === null ? policy.maxWork : width * height * Math.max(1, frames || fps * (duration ?? policy.maxDuration));
  }
  if (!Number.isFinite(work) || work > policy.maxWork || !Number.isSafeInteger(decodedBytes) || decodedBytes > policy.decodedBytes) throw refusal('Video decoded work exceeds the processing budget');
  return { decodedBytes, work: Math.ceil(work) };
}
module.exports = { configuration, estimate, refusal };
