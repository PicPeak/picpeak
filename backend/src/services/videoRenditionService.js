/**
 * Browser-playable copies of videos (issue 1430, item 8).
 *
 * Off by default: a copy costs CPU on ingest and a second file per video on
 * every install, so `general_video_web_rendition` has to be switched on. The
 * queue (videoRenditionQueue.js) claims rows with web_status = 'pending' and
 * calls renderWebCopy below, which decides per video:
 *
 *   - the original already plays in a browser (H.264 in an MP4 container,
 *     AAC or no audio, 8-bit 4:2:0, moov atom ahead of the media data):
 *     web_status 'skipped', nothing written
 *   - anything else: an H.264/AAC faststart MP4, capped at 1920 px on the
 *     long edge, written through the storage backend under videos/, and the
 *     gallery streams it instead of the original. The download stays the
 *     original.
 *
 * The copy lives in the managed backend even for an external (NAS) video:
 * PicPeak does not write into reference folders.
 *
 * Tunables (env, all optional):
 *   VIDEO_RENDITION_TIMEOUT_MS   default 3600000 (1 hour) per transcode
 *   VIDEO_RENDITION_MAX_EDGE     default 1920, longest edge of the copy
 *   VIDEO_RENDITION_CRF          default 23
 */

const path = require('path');
const fsp = require('fs').promises;
const os = require('os');
const crypto = require('crypto');
const ffmpeg = require('fluent-ffmpeg');
const { db } = require('../database/db');
const logger = require('../utils/logger');
const { getStorage } = require('./storage');
const { IS_VIDEO_SQL } = require('../utils/mediaTypeSql');

const SETTING_KEY = 'general_video_web_rendition';
const CACHE_TTL_MS = 60_000;

const TIMEOUT_MS = Math.max(60_000, parseInt(process.env.VIDEO_RENDITION_TIMEOUT_MS || '3600000', 10) || 3600000);
const MAX_EDGE = Math.max(240, parseInt(process.env.VIDEO_RENDITION_MAX_EDGE || '1920', 10) || 1920);
const CRF = Math.min(51, Math.max(0, parseInt(process.env.VIDEO_RENDITION_CRF || '23', 10) || 23));

let cachedEnabled = false;
let cacheExpiresAt = 0;

/** The setting, cached 60 s like the other upload settings. */
async function isEnabled() {
  if (Date.now() < cacheExpiresAt) return cachedEnabled;
  try {
    const row = await db('app_settings').where({ setting_key: SETTING_KEY }).first();
    let value = row ? row.setting_value : null;
    if (typeof value === 'string') {
      try { value = JSON.parse(value); } catch { /* keep the string */ }
    }
    cachedEnabled = value === true || value === 'true' || value === 1 || value === '1';
  } catch (error) {
    logger.error('Failed to read the video web rendition setting:', error.message);
    cachedEnabled = false;
  }
  cacheExpiresAt = Date.now() + CACHE_TTL_MS;
  return cachedEnabled;
}

function clearCache() {
  cacheExpiresAt = 0;
}

/**
 * Queue every video that has not been looked at, or whose last attempt
 * failed. Called when the setting is switched on, so an install that enables
 * it after years of uploads gets its back catalogue; the queue probes each
 * one and skips what already plays. Returns the number of rows queued.
 */
async function backfillPending() {
  return db('photos')
    .whereRaw(IS_VIDEO_SQL)
    .where(function () {
      this.whereNull('web_status').orWhere('web_status', 'failed');
    })
    .where(function () {
      this.where('processing_status', 'complete').orWhereNull('processing_status');
    })
    .update({ web_status: 'pending', web_error: null, web_started_at: null });
}

/** The storage key of a video's copy. The id keeps NAS basenames apart. */
function webKeyFor(photo) {
  const base = path.basename(photo.external_relpath || photo.filename || `video-${photo.id}`).replace(/\.[^.]+$/, '');
  return path.posix.join('videos', `web_${photo.id}_${base}.mp4`);
}

/**
 * Whether the moov atom comes before the media data. Browsers start playing
 * a progressive MP4 only once they have the moov; with it at the end, the
 * whole file downloads before the first frame, which is the "poor scrubbing
 * over a tunnel" the issue describes. ffprobe does not report atom order, so
 * the top-level boxes are walked directly: 8 bytes each (size, type), 16 for
 * a 64-bit size, 0 meaning "to the end of the file".
 */
async function hasFaststart(localPath) {
  const fh = await fsp.open(localPath, 'r');
  try {
    const { size: fileSize } = await fh.stat();
    let offset = 0;
    let moovAt = -1;
    let mdatAt = -1;
    const header = Buffer.alloc(16);
    for (let i = 0; i < 64 && offset + 8 <= fileSize; i++) {
      const { bytesRead } = await fh.read(header, 0, 16, offset);
      if (bytesRead < 8) break;
      let boxSize = header.readUInt32BE(0);
      const type = header.toString('latin1', 4, 8);
      let headerLen = 8;
      if (boxSize === 1) {
        if (bytesRead < 16) break;
        boxSize = Number(header.readBigUInt64BE(8));
        headerLen = 16;
      } else if (boxSize === 0) {
        boxSize = fileSize - offset;
      }
      if (type === 'moov' && moovAt < 0) moovAt = offset;
      if (type === 'mdat' && mdatAt < 0) mdatAt = offset;
      if (moovAt >= 0 && mdatAt >= 0) break;
      if (boxSize < headerLen) break; // not a box: stop guessing
      offset += boxSize;
    }
    if (moovAt < 0) return false;
    return mdatAt < 0 || moovAt < mdatAt;
  } finally {
    await fh.close();
  }
}

function probe(localPath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(localPath, (err, metadata) => {
      if (err) return reject(err);
      const video = (metadata.streams || []).find((s) => s.codec_type === 'video');
      const audio = (metadata.streams || []).find((s) => s.codec_type === 'audio');
      resolve({
        formatName: metadata.format?.format_name || '',
        majorBrand: String(metadata.format?.tags?.major_brand || '').trim().toLowerCase(),
        videoCodec: video?.codec_name || null,
        audioCodec: audio?.codec_name || null,
        pixFmt: video?.pix_fmt || null,
        width: video?.width || null,
        height: video?.height || null,
      });
    });
  });
}

/**
 * Whether a probed video plays as it is. Conservative on purpose: a copy of
 * something that would have played costs a transcode; the reverse costs a
 * guest a black player.
 */
function playsInBrowser(probed, faststart) {
  if (!probed || probed.videoCodec !== 'h264') return false;
  if (probed.audioCodec && probed.audioCodec !== 'aac') return false;
  if (probed.pixFmt && probed.pixFmt !== 'yuv420p') return false;
  // ffprobe reports one format name for .mp4 and .mov alike; the brand tells
  // a QuickTime file ('qt  ') from an ISO one.
  if (!/\bmp4\b/.test(probed.formatName) || probed.majorBrand === 'qt') return false;
  return !!faststart;
}

/**
 * ffmpeg's arguments for the copy, in one place so the test can pin them.
 * The scale keeps the aspect ratio, never upsizes, and keeps both sides
 * even, which libx264 needs for 4:2:0. ffmpeg applies the rotation tag on
 * input, so a portrait phone recording comes out portrait.
 */
function transcodeOptions() {
  return [
    '-map', '0:v:0',
    '-map', '0:a:0?',
    '-sn', '-dn',
    '-c:v', 'libx264',
    '-preset', 'medium',
    '-crf', String(CRF),
    '-pix_fmt', 'yuv420p',
    '-vf', `scale=w='min(${MAX_EDGE},iw)':h='min(${MAX_EDGE},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2`,
    '-c:a', 'aac',
    '-b:a', '128k',
    '-movflags', '+faststart',
    '-f', 'mp4',
  ];
}

function transcode(localPath, outPath, { timeoutMs = TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    let timer = null;
    const command = ffmpeg(localPath).outputOptions(transcodeOptions());
    command
      .on('end', () => { clearTimeout(timer); resolve(); })
      .on('error', (err) => { clearTimeout(timer); reject(err); });
    timer = setTimeout(() => {
      try { command.kill('SIGKILL'); } catch { /* already gone */ }
      reject(new Error(`transcode timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    command.save(outPath);
  });
}

/**
 * Decide for one video and, if needed, write its copy. Throws on failure so
 * the queue records it; returns the status it wrote otherwise.
 */
async function renderWebCopy(photoId) {
  const photo = await db('photos').where({ id: photoId }).first();
  if (!photo) throw new Error(`Photo ${photoId} not found`);
  const event = await db('events').where({ id: photo.event_id }).first();
  if (!event) throw new Error(`Event ${photo.event_id} not found for photo ${photoId}`);

  const isVideo = photo.media_type === 'video'
    || (typeof photo.mime_type === 'string' && photo.mime_type.startsWith('video/'));
  if (!isVideo) {
    await db('photos').where({ id: photoId }).update({ web_status: 'skipped', web_started_at: null, web_error: null });
    return 'skipped';
  }

  const { resolvePhotoStorageKey, resolvePhotoFilePath } = require('./photoResolver');
  const { withLocalCopy } = require('./imageProcessor');
  const sourceKey = resolvePhotoStorageKey(event, photo);
  const withSource = sourceKey
    ? (fn) => withLocalCopy(sourceKey, fn)
    : (fn) => fn(resolvePhotoFilePath(event, photo));

  const status = await withSource(async (localPath) => {
    const probed = await probe(localPath);
    if (playsInBrowser(probed, await hasFaststart(localPath))) {
      // A stale copy from an earlier source (a replacement, say) is not
      // worth keeping: the original is what plays now.
      if (photo.web_path) await getStorage().delete(photo.web_path).catch(() => {});
      await db('photos').where({ id: photoId }).update({
        web_path: null, web_status: 'skipped', web_started_at: null, web_error: null,
      });
      return 'skipped';
    }

    const webKey = webKeyFor(photo);
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'picpeak-webcopy-'));
    const tmpPath = path.join(tmpDir, `${crypto.randomBytes(4).toString('hex')}.mp4`);
    try {
      await transcode(localPath, tmpPath);
      const stat = await fsp.stat(tmpPath).catch(() => null);
      if (!stat || stat.size === 0) throw new Error('ffmpeg produced no output');
      await getStorage().putFromFile(webKey, tmpPath, { contentType: 'video/mp4' });
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
    await db('photos').where({ id: photoId }).update({
      web_path: webKey, web_status: 'complete', web_started_at: null, web_error: null,
    });
    logger.info(`videoRendition: wrote ${webKey} for photo ${photoId} (${probed.videoCodec}/${probed.audioCodec || 'no audio'}, ${probed.majorBrand || probed.formatName})`);
    return 'complete';
  });
  return status;
}

/** Remove a video's copy from storage; for the delete and replace paths. */
async function deleteWebCopy(photo) {
  if (!photo?.web_path) return;
  await getStorage().delete(photo.web_path).catch(() => {});
}

module.exports = {
  SETTING_KEY,
  isEnabled,
  clearCache,
  backfillPending,
  webKeyFor,
  hasFaststart,
  probe,
  playsInBrowser,
  transcodeOptions,
  transcode,
  renderWebCopy,
  deleteWebCopy,
};
