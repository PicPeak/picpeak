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

const WEB_KEY_BASENAME_MAX = 100;

/** The longest prefix of `str` that fits `max` UTF-8 bytes, on a code point boundary. */
function capUtf8Bytes(str, max) {
  let out = '';
  for (const ch of str) {
    if (Buffer.byteLength(out + ch, 'utf8') > max) break;
    out += ch;
  }
  return out;
}
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
async function backfillPending({ eventId } = {}) {
  const { formatBoolean } = require('../utils/dbCompat');
  return db('photos')
    .modify((q) => { if (eventId != null) q.where('event_id', eventId); })
    // An archived gallery's originals are in its zip, not in storage: queuing
    // its rows would only fail. The restore route backfills the event again.
    .whereNotIn('event_id', db('events').select('id').where('is_archived', formatBoolean(true)))
    .whereRaw(IS_VIDEO_SQL)
    .where(function () {
      this.whereNull('web_status').orWhere('web_status', 'failed');
    })
    .where(function () {
      this.where('processing_status', 'complete').orWhereNull('processing_status');
    })
    .update({ web_status: 'pending', web_error: null, web_started_at: null });
}

/**
 * The storage key of a video's copy. The id keeps NAS basenames apart; the
 * claim token keeps attempts apart: a worker whose claim was lost deletes
 * its own object and can never touch the one the current attempt wrote.
 */
function webKeyFor(photo, claimedAt) {
  const attempt = claimedAt ? `${new Date(claimedAt).getTime().toString(36)}_` : '';
  // The basename is for a human reading the bucket; the id and claim make
  // the key unique. Capped in UTF-8 bytes (a filesystem counts bytes, not
  // characters) so a long NAS filename plus prefix, id, claim and
  // LocalFsStorage's staging suffix stays under the 255-byte name limit.
  const base = capUtf8Bytes(
    path.basename(photo.external_relpath || photo.filename || `video-${photo.id}`).replace(/\.[^.]+$/, ''),
    WEB_KEY_BASENAME_MAX,
  );
  return path.posix.join('videos', `web_${photo.id}_${attempt}${base}.mp4`);
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
        // HDR is told by the transfer function: PQ (smpte2084) or HLG
        // (arib-std-b67). The primaries (bt2020) alone do not make a video HDR.
        colorTransfer: video?.color_transfer || null,
        colorPrimaries: video?.color_primaries || null,
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

/** Whether a probed video is HDR: PQ or HLG transfer, as phones record it. */
function isHdr(probed) {
  return probed?.colorTransfer === 'smpte2084' || probed?.colorTransfer === 'arib-std-b67';
}

/**
 * HDR to SDR for the copy. Dropping an HDR source to yuv420p alone keeps the
 * HDR transfer curve in an 8-bit SDR container, which plays dark and flat
 * (the scene's highlights are mapped as mid-greys). This chain goes to
 * linear light, tone-maps the range into what an SDR display shows (Hable,
 * the film-like curve; `desat=0` keeps the colours), and lands on BT.709,
 * which is what every browser assumes for H.264. Needs ffmpeg's zscale
 * (libzimg) and tonemap filters: Alpine's ffmpeg package in the image has
 * both; canToneMap checks at runtime for anyone on another build.
 */
const HDR_TO_SDR_FILTER = 'zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv';

let toneMapSupport = null;
/** Whether this ffmpeg has the filters HDR_TO_SDR_FILTER needs. Asked once. */
function canToneMap() {
  if (!toneMapSupport) {
    toneMapSupport = new Promise((resolve) => {
      try {
        ffmpeg.getAvailableFilters((err, filters) => {
          resolve(!err && !!filters && !!filters.zscale && !!filters.tonemap);
        });
      } catch {
        resolve(false);
      }
    });
  }
  return toneMapSupport;
}

/** Forget the capability answer, so a test can mock another ffmpeg. */
function _resetToneMapSupportForTests() {
  toneMapSupport = null;
}

/**
 * ffmpeg's arguments for the copy, in one place so the test can pin them.
 * The scale keeps the aspect ratio, never upsizes, and keeps both sides
 * even, which libx264 needs for 4:2:0. ffmpeg applies the rotation tag on
 * input, so a portrait phone recording comes out portrait. With `toneMap`
 * the HDR to SDR chain runs first, so the scale works on the SDR picture.
 */
function transcodeOptions({ toneMap = false } = {}) {
  const scale = `scale=w='min(${MAX_EDGE},iw)':h='min(${MAX_EDGE},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2`;
  return [
    '-map', '0:v:0',
    '-map', '0:a:0?',
    '-sn', '-dn',
    '-c:v', 'libx264',
    '-preset', 'medium',
    '-crf', String(CRF),
    '-pix_fmt', 'yuv420p',
    '-vf', toneMap ? `${HDR_TO_SDR_FILTER},${scale}` : scale,
    // BT.709 tags on the output: the copy is SDR whatever the source was, and
    // a player that honoured leftover BT.2020/PQ tags would misrender it.
    ...(toneMap ? ['-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709'] : []),
    '-c:a', 'aac',
    '-b:a', '128k',
    '-movflags', '+faststart',
    '-f', 'mp4',
  ];
}

function transcode(localPath, outPath, { timeoutMs = TIMEOUT_MS, toneMap = false } = {}) {
  return new Promise((resolve, reject) => {
    let timer = null;
    const command = ffmpeg(localPath).outputOptions(transcodeOptions({ toneMap }));
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
async function renderWebCopy(photoId, { claimedAt } = {}) {
  const photo = await db('photos').where({ id: photoId }).first();
  if (!photo) throw new Error(`Photo ${photoId} not found`);
  // The worker's claim, as the queue wrote it: status plus claim time. Every
  // write below matches on it, so a worker that lost the row — replaced,
  // deleted, or re-queued by the janitor and claimed again by another
  // worker — writes nothing. Without the time, a second claim on the same
  // row would look like the first.
  const claim = { id: photoId, web_status: 'processing', ...(claimedAt ? { web_started_at: claimedAt } : {}) };
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
      // Same fence as the publish below: a row that moved on keeps its state.
      await db('photos').where(claim).update({
        web_path: null, web_status: 'skipped', web_started_at: null, web_error: null,
      });
      return 'skipped';
    }

    const webKey = webKeyFor(photo, claimedAt);
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'picpeak-webcopy-'));
    const tmpPath = path.join(tmpDir, `${crypto.randomBytes(4).toString('hex')}.mp4`);
    // An HDR source is tone-mapped to SDR when this ffmpeg can; otherwise the
    // copy is still made (it plays, which the original did not) and the log
    // says why it looks flat.
    const hdr = isHdr(probed);
    const toneMap = hdr && await canToneMap();
    if (hdr && !toneMap) {
      logger.warn(`videoRendition: photo ${photoId} is HDR (${probed.colorTransfer}) but this ffmpeg lacks zscale/tonemap; the copy is not tone-mapped`);
    }
    try {
      await transcode(localPath, tmpPath, { toneMap });
      const stat = await fsp.stat(tmpPath).catch(() => null);
      if (!stat || stat.size === 0) throw new Error('ffmpeg produced no output');
      await getStorage().putFromFile(webKey, tmpPath, { contentType: 'video/mp4' });
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
    // Publish only against this worker's claim. A replacement
    // (photoReplacementService) resets the columns and re-queues the new
    // file mid-transcode, a delete removes the row, the janitor may have
    // handed a stuck claim to another worker: writing the copy of the old
    // source over any of those would serve stale content and lose the new
    // file's queue entry. On a lost claim the object is dropped again; the
    // key carries the claim, so it is this attempt's object and no other's.
    const published = await db('photos').where(claim).update({
      web_path: webKey, web_status: 'complete', web_started_at: null, web_error: null,
    });
    if (!published) {
      await getStorage().delete(webKey).catch(() => {});
      logger.info(`videoRendition: photo ${photoId} changed during the transcode, dropped ${webKey}`);
      return 'superseded';
    }
    logger.info(`videoRendition: wrote ${webKey} for photo ${photoId} (${probed.videoCodec}/${probed.audioCodec || 'no audio'}, ${probed.majorBrand || probed.formatName}${toneMap ? ', HDR tone-mapped' : ''})`);
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
  isHdr,
  canToneMap,
  _resetToneMapSupportForTests,
  HDR_TO_SDR_FILTER,
  transcode,
  renderWebCopy,
  deleteWebCopy,
};
