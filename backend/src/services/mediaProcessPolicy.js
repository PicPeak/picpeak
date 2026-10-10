const os = require('os');
const { configuration: imageConfiguration, effectiveMemory, refusal: imageRefusal, isTransient, isResourceError } = require('./imageResourcePolicy');
const MiB = 1024 * 1024;
// 503 for "not now" codes, 422 otherwise; the list lives with the image codes.
function refusal(message, code = 'MEDIA_RESOURCE_LIMIT', detail) { return imageRefusal(message, code, detail); }
function positive(name, fallback, maximum) {
  const raw = process.env[name];
  const value = raw === undefined || raw === '' ? fallback : Number(raw);
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) throw new Error(`Invalid ${name}`);
  return value;
}
const optionalMiB = (name, maximum) => { const value = positive(name, null, maximum); return value === null ? null : value * MiB; };
function configuration() {
  const image = imageConfiguration();
  // Address-space limit for ffprobe, exiftool and a single poster frame under
  // the process guard. Virtual, not resident, memory: generous on purpose.
  const nativeBytes = positive('MEDIA_WORKER_MEMORY_MIB', 2048, 65536) * MiB;
  const decodedBytes = Math.min(image.decodedBytes || Infinity, nativeBytes / 2);
  const cpus = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
  // Unset means "no limit of its own", as before this policy existed: a
  // video is not refused for its size, length or the work it takes unless
  // the operator sets one of these.
  const inputBytes = optionalMiB('MEDIA_MAX_INPUT_MIB', 1048576);
  return { nativeBytes, decodedBytes, inputBytes,
    // A transcode runs without an address-space limit unless one is set: a
    // multi-threaded x264 encode of a 4K source reserves far more virtual
    // memory than it uses, and no single default is known to fit them all.
    transcodeBytes: optionalMiB('MEDIA_FFMPEG_MEMORY_MIB', 1048576) || 0,
    threads: positive('MEDIA_FFMPEG_THREADS', Math.max(1, Math.min(cpus || 1, 4)), 64),
    snapshotBytes: Math.min(positive('MEDIA_MAX_SNAPSHOT_MIB', 1024, 1048576) * MiB, Math.floor(effectiveMemory() / 2)),
    outputBytes: optionalMiB('MEDIA_MAX_VIDEO_OUTPUT_MIB', 1048576),
    maxPixels: Math.min(positive('MEDIA_MAX_VIDEO_PIXELS', 40000000, 268402689), Math.floor(decodedBytes / 8)),
    maxDimension: positive('MEDIA_MAX_VIDEO_DIMENSION', 16384, 65535),
    maxStreams: positive('MEDIA_MAX_VIDEO_STREAMS', 16, 64),
    maxDuration: positive('MEDIA_MAX_VIDEO_DURATION_SECONDS', null, 604800),
    maxFps: positive('MEDIA_MAX_VIDEO_FPS', 240, 1000),
    maxWork: positive('MEDIA_MAX_VIDEO_PIXEL_FRAMES', null, Number.MAX_SAFE_INTEGER),
    probeMs: positive('MEDIA_PROBE_TIMEOUT_MS', 30000, 600000),
    rawMs: positive('MEDIA_RAW_TIMEOUT_MS', 30000, 600000),
    thumbnailMs: positive('MEDIA_THUMBNAIL_TIMEOUT_MS', 60000, 600000),
    // The least a transcode gets, as VIDEO_RENDITION_TIMEOUT_MS always was;
    // a long video gets more (renditionBudget), up to the ceiling.
    renditionMs: Math.max(60000, parseInt(process.env.VIDEO_RENDITION_TIMEOUT_MS || '3600000', 10) || 3600000),
    renditionMaxMs: positive('VIDEO_RENDITION_MAX_TIMEOUT_MS', 86400000, 604800000),
    rawOutputBytes: 64 * MiB,
  };
}
// Wall-clock allowance per second of video. x264 on one slow core, or a
// tone-mapped 4K HDR source, runs many times slower than real time.
const RENDITION_MS_PER_VIDEO_SECOND = 20000;
/** Time for one transcode: grows with the video's length and the thread count. */
function renditionBudget(durationSeconds, policy = configuration()) {
  const scaled = Number.isFinite(durationSeconds) && durationSeconds > 0 ? Math.ceil(durationSeconds * RENDITION_MS_PER_VIDEO_SECOND) : 0;
  const wallMs = Math.max(policy.renditionMs, Math.min(Math.max(policy.renditionMaxMs, policy.renditionMs), scaled));
  return { wallMs, cpuSeconds: Math.min(2592000, Math.ceil(wallMs / 1000) * policy.threads) };
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
  if (duration !== null && policy.maxDuration && duration > policy.maxDuration) throw refusal('Video duration exceeds the processing budget');
  let decodedBytes = 0, work = 0, unknownWork = false;
  const videos = metadata.streams.filter(stream => stream.codec_type === 'video');
  if (!videos.length) throw refusal('Video has no video stream', 'MEDIA_INVALID_SIGNATURE');
  for (const stream of videos) {
    const width = numeric(stream.width, 'width'), height = numeric(stream.height, 'height');
    const fps = rate(stream.avg_frame_rate) || rate(stream.r_frame_rate) || 120;
    const frames = numeric(stream.nb_frames, 'frame count', { zero: true });
    if (fps > policy.maxFps) throw refusal('Video frame rate exceeds the processing budget');
    if (width === null || height === null) { decodedBytes += policy.decodedBytes; unknownWork = true; continue; }
    if (![width, height].every(Number.isSafeInteger) || width > policy.maxDimension || height > policy.maxDimension || width * height > policy.maxPixels) throw refusal('Video dimensions exceed the processing budget');
    // Decoder reference frames/filter intermediates, not only compressed bytes.
    const hdr = /(?:10|12|14|16)(?:le|be)?$/.test(stream.pix_fmt || '') || ['smpte2084', 'arib-std-b67'].includes(stream.color_transfer);
    decodedBytes += width * height * (hdr ? 16 : 8);
    if (duration === null && frames === null) unknownWork = true;
    else work += width * height * Math.max(1, frames || fps * duration);
  }
  // Unknown length counts as the whole budget, but only where one is set.
  if (unknownWork && policy.maxWork) work = policy.maxWork;
  if (!Number.isFinite(work) || (policy.maxWork && work > policy.maxWork) || !Number.isSafeInteger(decodedBytes) || decodedBytes > policy.decodedBytes) throw refusal('Video decoded work exceeds the processing budget');
  return { decodedBytes, work: Math.ceil(work), duration };
}
/** "Not now" or "no longer yours": never a verdict on the media itself. */
function isInterruption(error) {
  return isTransient(error) || error?.code === 'MEDIA_SUPERSEDED' || error?.code === 'MEDIA_ATTEMPT_REQUIRED';
}
module.exports = { configuration, estimate, refusal, renditionBudget, isTransient, isResourceError, isInterruption };
