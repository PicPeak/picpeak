/**
 * Browser-playable copies of videos (issue 1430, item 8).
 *
 * Two settings put videos on the queue (videoRenditionQueue.js), which
 * claims rows with web_status = 'pending' and calls renderWebCopy below:
 * `general_video_web_rendition` (transcodes, off by default: CPU on ingest
 * and a second file per video) and `general_video_strip_metadata` (issue
 * 2102, on by default: no guest receives a phone's recording location).
 * Per video:
 *
 *   - the original already plays in a browser (H.264 in an MP4 container,
 *     AAC or no audio, 8-bit 4:2:0, moov atom ahead of the media data):
 *     with stripping on, a remux without the source's metadata. Stream copy,
 *     no re-encode; published like a transcoded copy, whether or not the
 *     transcodes are on. With stripping off: web_status 'skipped', nothing
 *     written, and the original plays as it is
 *   - anything else, with the transcodes on: an H.264/AAC faststart MP4,
 *     capped at 1920 px on the long edge, written through the storage
 *     backend under videos/, and the gallery streams it instead of the
 *     original. The download stays the original.
 *   - anything else, with the transcodes off: web_status 'deferred', nothing
 *     written; switching the transcodes on queues it (backfillPending)
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
const mediaProcesses = require('./mediaProcessService');
const { isInterruption, configuration: mediaPolicy, renditionBudget } = require('./mediaProcessPolicy');
const { db } = require('../database/db');
const logger = require('../utils/logger');
const { getStorage } = require('./storage');
const { IS_VIDEO_SQL } = require('../utils/mediaTypeSql');
const mediaAttempts = require('./mediaAttemptService');

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
// Issue 2102: a played video carries no location or device tags. On unless
// an admin switched it off, so a missing row means on.
const STRIP_SETTING_KEY = 'general_video_strip_metadata';
const CACHE_TTL_MS = 60_000;

const MAX_EDGE = Math.min(4096, Math.max(240, parseInt(process.env.VIDEO_RENDITION_MAX_EDGE || '1920', 10) || 1920));
const CRF = Math.min(51, Math.max(0, parseInt(process.env.VIDEO_RENDITION_CRF || '23', 10) || 23));

let cachedEnabled = false;
let cacheExpiresAt = 0;

/** The setting, cached 60 s like the other upload settings. */
async function isEnabled({ fresh = false } = {}) {
  if (!fresh && Date.now() < cacheExpiresAt) return cachedEnabled;
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

let cachedStrip = true;
let stripExpiresAt = 0;

/**
 * Whether a browser-compatible original gets a metadata-free remux instead
 * of being skipped. Defaults to on: no row, or one that cannot be read, is
 * the privacy-preserving answer.
 */
async function isStripEnabled({ fresh = false } = {}) {
  if (!fresh && Date.now() < stripExpiresAt) return cachedStrip;
  try {
    const { decodeSettingValue } = require('./eventSettings');
    const row = await db('app_settings').where({ setting_key: STRIP_SETTING_KEY }).first();
    const value = row ? decodeSettingValue(row.setting_value) : null;
    cachedStrip = !(value === false || value === 'false' || value === 0 || value === '0');
  } catch (error) {
    logger.error('Failed to read the video metadata setting:', error.message);
    cachedStrip = true;
  }
  stripExpiresAt = Date.now() + CACHE_TTL_MS;
  return cachedStrip;
}

function clearCache() {
  cacheExpiresAt = 0;
  stripExpiresAt = 0;
}

/**
 * Whether new videos go on the queue and the workers run: while either the
 * transcodes or metadata stripping is on. renderWebCopy decides per video
 * what, if anything, it writes.
 */
async function queuesVideos() {
  return (await isEnabled()) || (await isStripEnabled());
}

/** The rows backfillPending and queueForMetadataStrip hand to the queue. */
function queueVideos(statuses, { eventId, includeNull = false } = {}) {
  const { formatBoolean } = require('../utils/dbCompat');
  return db('photos')
    .modify((q) => { if (eventId != null) q.where('event_id', eventId); })
    // An archived gallery's originals are in its zip, not in storage: queuing
    // its rows would only fail. The restore route backfills the event again.
    .whereNotIn('event_id', db('events').select('id').where('is_archived', formatBoolean(true)))
    .whereRaw(IS_VIDEO_SQL)
    .where(function () {
      this.whereIn('web_status', statuses);
      if (includeNull) this.orWhereNull('web_status');
    })
    .where(function () {
      this.where('processing_status', 'complete').orWhereNull('processing_status');
    })
    .update({ web_status: 'pending', web_error: null, web_started_at: null, web_attempts: 0, web_retry_at: null });
}

/**
 * Queue every video that has not been looked at, or whose last attempt
 * failed. Called when the setting is switched on, so an install that enables
 * it after years of uploads gets its back catalogue; the queue probes each
 * one and skips what already plays. Returns the number of rows queued.
 */
async function backfillPending({ eventId } = {}) {
  // One UPDATE and nothing else: the settings request that switches the
  // feature on must not probe a back catalogue. The queue probes each video
  // when its turn comes, and a long backlog simply waits.
  // Videos in the trash are queued too; the queue leaves them alone until
  // they are restored (mediaAttemptService.claimNext).
  // 'deferred' is a video that needs a transcode and was looked at while
  // the transcodes were off. With metadata stripping on, a video skipped
  // earlier (it played as it was) is queued too: it gets its remux now.
  const statuses = (await isStripEnabled()) ? ['failed', 'deferred', 'skipped'] : ['failed', 'deferred'];
  return queueVideos(statuses, { eventId, includeNull: true });
}

/**
 * Queue the videos that may need a metadata-free remux (issue 2102): those
 * skipped as browser-compatible and those never looked at. Called when the
 * strip setting is switched on, after an archive restore, and once per
 * start (an upgraded install's back catalogue); a no-op while stripping is
 * off, and whether or not the transcodes are on. 'deferred' and 'failed'
 * rows are left alone: the first needs a transcode, the second gets its
 * retry from backfillPending. A row stays 'pending' until a worker takes
 * it, so an interrupted backfill resumes by itself. Returns the number of
 * rows queued.
 */
async function queueForMetadataStrip({ eventId } = {}) {
  if (!(await isStripEnabled())) return 0;
  return queueVideos(['skipped'], { eventId, includeNull: true });
}

/**
 * Re-queue rows a worker decided on a moment before a setting changed: a
 * video marked 'deferred' while the transcodes were being switched on, or
 * 'skipped' while stripping was. The switch-on backfill could not take
 * them (they were in flight), and nothing else would. Run by the queue's
 * janitor every minute; both statuses are indexed and normally match no
 * row, so it is cheap. Returns the number of rows queued.
 */
async function requeueStranded() {
  const statuses = [];
  if (await isEnabled()) statuses.push('deferred');
  if (await isStripEnabled()) statuses.push('skipped');
  if (statuses.length === 0) return 0;
  return queueVideos(statuses);
}

/**
 * The storage key of a video's copy. The id keeps NAS basenames apart; the
 * claim token keeps attempts apart: a worker whose claim was lost deletes
 * its own object and can never touch the one the current attempt wrote.
 */
function webKeyFor(photo, claimedAt, { remux = false } = {}) {
  const token = /^[a-f0-9-]{36}$/i.test(claimedAt || '') ? claimedAt : claimedAt ? new Date(claimedAt).getTime().toString(36) : '';
  const attempt = token ? `${token}_` : '';
  // The basename is for a human reading the bucket; the id and claim make
  // the key unique. Capped in UTF-8 bytes (a filesystem counts bytes, not
  // characters) so a long NAS filename plus prefix, id, claim and
  // LocalFsStorage's staging suffix stays under the 255-byte name limit.
  const base = capUtf8Bytes(
    path.basename(photo.external_relpath || photo.filename || `video-${photo.id}`).replace(/\.[^.]+$/, ''),
    WEB_KEY_BASENAME_MAX,
  );
  // A remux carries a marker the gallery reads (galleryAssetPolicy.isRemuxWebKey):
  // it is the original's picture, so playing it is not free under a
  // download limit the way a transcoded copy is.
  return path.posix.join('videos', `web_${photo.id}_${remux ? 'remux_' : ''}${attempt}${base}.mp4`);
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

/**
 * The stream of a type a player picks: the one flagged default, else the
 * first. A cover image (attached_pic) is never the picture.
 */
function playedStream(streams, type) {
  const candidates = streams.filter((s) => s.codec_type === type && !s.disposition?.attached_pic);
  return candidates.find((s) => s.disposition?.default) || candidates[0]
    || streams.find((s) => s.codec_type === type);
}

/**
 * Absolute indexes of the played video and audio stream, for the -map
 * arguments. Taken from the probe of the very snapshot ffmpeg reads (see
 * transcode): a NAS file replaced since the first probe must not be mapped
 * by its predecessor's layout.
 */
function playedStreamIndexes(metadata) {
  const streams = metadata?.streams || [];
  const index = (s) => (Number.isInteger(s?.index) ? s.index : null);
  return { videoIndex: index(playedStream(streams, 'video')), audioIndex: index(playedStream(streams, 'audio')) };
}

async function probe(localPath) {
  return describeProbe(await mediaProcesses.probeVideo(localPath));
}

/** ffprobe's answer, reduced to what the decisions below read. */
function describeProbe(metadata) {
  const streams = metadata?.streams || [];
  const video = playedStream(streams, 'video');
  const audio = playedStream(streams, 'audio');
  return {
    formatName: metadata?.format?.format_name || '',
    majorBrand: String(metadata?.format?.tags?.major_brand || '').trim().toLowerCase(),
    videoCodec: video?.codec_name || null,
    audioCodec: audio?.codec_name || null,
    pixFmt: video?.pix_fmt || null,
    width: video?.width || null,
    height: video?.height || null,
    // HDR is told by the transfer function: PQ (smpte2084) or HLG
    // (arib-std-b67). The primaries (bt2020) alone do not make a video HDR.
    colorTransfer: video?.color_transfer || null,
    colorPrimaries: video?.color_primaries || null,
    duration: Number(metadata?.format?.duration) || null,
  };
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
    toneMapSupport = mediaProcesses.run('ffmpeg', ['-hide_banner', '-filters'], {
      memoryBytes: mediaPolicy().nativeBytes, wallMs: 10000, cpuSeconds: 10,
    }).then(({ stdout }) => /\bzscale\b/.test(stdout.toString()) && /\btonemap\b/.test(stdout.toString()))
      .catch(error => { if (isInterruption(error)) { toneMapSupport = null; throw error; } return false; });
  }
  return toneMapSupport;
}

/** Forget the capability answer, so a test can mock another ffmpeg. */
function _resetToneMapSupportForTests() {
  toneMapSupport = null;
}

/**
 * The tracks a copy is made from: the played (default) ones, by absolute
 * index (playedStreamIndexes), the same choice probe() bases the decision
 * and the tone mapping on; the first video and optional audio stream when
 * there is no index.
 */
function streamMaps({ videoIndex = null, audioIndex = null } = {}) {
  return [
    '-map', videoIndex == null ? '0:v:0' : `0:${videoIndex}`,
    '-map', audioIndex == null ? '0:a:0?' : `0:${audioIndex}`,
  ];
}

/**
 * ffmpeg's arguments for the copy, in one place so the test can pin them.
 * The scale keeps the aspect ratio, never upsizes, and keeps both sides
 * even, which libx264 needs for 4:2:0. ffmpeg applies the rotation tag on
 * input, so a portrait phone recording comes out portrait. With `toneMap`
 * the HDR to SDR chain runs first, so the scale works on the SDR picture.
 */
function transcodeOptions({ toneMap = false, videoIndex = null, audioIndex = null } = {}) {
  const scale = `scale=w='min(${MAX_EDGE},iw)':h='min(${MAX_EDGE},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2`;
  return [
    ...streamMaps({ videoIndex, audioIndex }),
    '-sn', '-dn',
    // No container, stream or chapter metadata from the source: a phone's
    // recording location, artist and device tags must not reach guests.
    '-map_metadata', '-1', '-map_chapters', '-1',
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

/**
 * ffmpeg's arguments for the metadata-free remux of a video that already
 * plays (issue 2102). Stream copy: same picture and sound, no re-encode. The
 * container, stream and chapter metadata (location, artist, device tags) is
 * dropped; the rotation is stream side data, not a tag, and survives the
 * copy. Faststart keeps the moov in front, as the original had it. With the
 * probe's indexes it maps the tracks a player picks in the original (the
 * default ones), not merely the first.
 */
function remuxOptions({ videoIndex = null, audioIndex = null } = {}) {
  return [
    ...streamMaps({ videoIndex, audioIndex }),
    '-c', 'copy',
    '-map_metadata', '-1', '-map_chapters', '-1',
    '-movflags', '+faststart',
    '-f', 'mp4',
  ];
}

/**
 * `duration` (seconds, from the probe) sizes the time budget: a long video
 * gets longer than VIDEO_RENDITION_TIMEOUT_MS, which is only the minimum.
 * `timeoutMs` overrides it (tests).
 */
function transcode(localPath, outPath, { timeoutMs, toneMap = false, duration, remux = false, mayTranscode = true } = {}) {
  return mediaProcesses.withSnapshot(localPath, 'rendition', async (snapshot, details) => {
    const { policy } = details;
    const metadata = await mediaProcesses.probeSnapshot(snapshot, details);
    const budget = renditionBudget(Number.isFinite(duration) ? duration : Number(metadata.format?.duration), policy);
    const streams = playedStreamIndexes(metadata);
    // The decision was made on an earlier read of the file. A NAS file
    // replaced since by one a browser cannot play must not be stream-copied
    // into a "copy" that plays black: it is transcoded instead, or, with the
    // transcodes off, the attempt fails and the original plays (the faststart
    // of the snapshot does not matter, the remux writes its own).
    let copy = remux;
    let mapTones = toneMap;
    if (remux) {
      const now = describeProbe(metadata);
      if (!playsInBrowser(now, true)) {
        if (!mayTranscode) throw new Error('The video changed before its remux and no longer plays as it is; browser-playable copies are off');
        copy = false;
        mapTones = isHdr(now) && await canToneMap();
        logger.warn(`videoRendition: ${localPath} changed before its remux and no longer plays as it is; transcoding it instead`);
      }
    }
    await mediaProcesses.run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
      ...mediaProcesses.inputOptions(details.format, policy.threads), '-i', snapshot,
      ...(copy ? remuxOptions(streams) : transcodeOptions({ toneMap: mapTones, ...streams })), '-threads', String(policy.threads), '-filter_threads', String(policy.threads), outPath], {
      // Its own lane, so posters and probes never wait behind a transcode.
      lane: 'long', memoryBytes: policy.transcodeBytes, wallMs: timeoutMs || budget.wallMs, cpuSeconds: budget.cpuSeconds,
      fileBytes: policy.outputBytes || 1024 * 1024 * 1024 * 1024,
    });
    // What was written, so the copy's key names it (a remux is counted like
    // the original, a transcode plays free).
    return { remuxed: !!copy };
  });
}

/**
 * Decide for one video and, if needed, write its copy. Throws on failure so
 * the queue records it; returns the status it wrote otherwise.
 */
async function renderWebCopy(photoId) {
  if (!mediaAttempts.current()) {
    const claimed = await mediaAttempts.claimNext('web', photoId);
    if (!claimed || claimed.exhausted) throw require('./mediaProcessPolicy').refusal(`Video ${photoId} is not pending, or is being converted already`, 'MEDIA_ATTEMPT_REQUIRED');
    return mediaAttempts.execute(claimed, 'web', () => renderWebCopy(photoId));
  }
  const attempt = mediaAttempts.current();
  await attempt.assertCurrent();
  const photo = await db('photos').where({ id: photoId }).first();
  if (!photo) throw new Error(`Photo ${photoId} not found`);
  // UUID + source identity fence every publication, including skipped rows.
  const event = await db('events').where({ id: photo.event_id }).first();
  if (!event) throw new Error(`Event ${photo.event_id} not found for photo ${photoId}`);

  // Case-blind like SQLite's LIKE in IS_VIDEO_SQL: a row the sweeps take as
  // a video must not be marked skipped here, or the janitor's 'skipped'
  // sweep (requeueStranded) would queue it again every minute.
  const isVideo = photo.media_type === 'video'
    || (typeof photo.mime_type === 'string' && photo.mime_type.toLowerCase().startsWith('video/'));
  if (!isVideo) {
    await mediaAttempts.guard(attempt, db, true).update({ web_status: 'skipped', web_started_at: null, web_error: null });
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
    const remux = playsInBrowser(probed, await hasFaststart(localPath));
    // Needs a transcode, and the transcodes are off (the row is here for
    // metadata stripping): nothing is written, the original plays as it
    // always did, and switching the transcodes on queues it again. Read past
    // the cache for the same reason as below.
    if (!remux && !(await isEnabled({ fresh: true }))) {
      await attempt.assertCurrent();
      const published = await mediaAttempts.guard(attempt, db, true).update({
        web_path: null, web_status: 'deferred', web_started_at: null, web_error: null,
      });
      if (published && photo.web_path) await getStorage().delete(photo.web_path).catch(() => {});
      return 'deferred';
    }
    // Read past the cache: another replica may have switched stripping on
    // and queued this row a moment ago; a stale "off" here would mark it
    // skipped again, and nothing would queue it a second time.
    if (remux && !(await isStripEnabled({ fresh: true }))) {
      // A stale copy from an earlier source (a replacement, say) is not
      // worth keeping: the original is what plays now.
      await attempt.assertCurrent();
      // Same fence as the publish below: a row that moved on keeps its state.
      const published = await mediaAttempts.guard(attempt, db, true).update({
        web_path: null, web_status: 'skipped', web_started_at: null, web_error: null,
      });
      if (published && photo.web_path) await getStorage().delete(photo.web_path).catch(() => {});
      return 'skipped';
    }

    let webKey = null;
    let remuxed = false;
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'picpeak-webcopy-'));
    const tmpPath = path.join(tmpDir, `${crypto.randomBytes(4).toString('hex')}.mp4`);
    // An HDR source is tone-mapped to SDR when this ffmpeg can; otherwise the
    // copy is still made (it plays, which the original did not) and the log
    // says why it looks flat.
    // A remux copies the streams: there is nothing to tone-map.
    const hdr = !remux && isHdr(probed);
    const toneMap = hdr && await canToneMap();
    if (hdr && !toneMap) {
      logger.warn(`videoRendition: photo ${photoId} is HDR (${probed.colorTransfer}) but this ffmpeg lacks zscale/tonemap; the copy is not tone-mapped`);
    }
    try {
      ({ remuxed } = await transcode(localPath, tmpPath, {
        toneMap, duration: probed.duration, remux, mayTranscode: !remux || await isEnabled(),
      }));
      webKey = webKeyFor(photo, attempt.id, { remux: remuxed });
      const stat = await fsp.stat(tmpPath).catch(() => null);
      if (!stat || stat.size === 0) throw new Error('ffmpeg produced no output');
      const { outputBytes } = mediaPolicy();
      if (outputBytes && stat.size > outputBytes) throw require('./mediaProcessPolicy').refusal(`Video copy is larger than ${outputBytes / 1048576} MiB (MEDIA_MAX_VIDEO_OUTPUT_MIB)`);
      await attempt.assertCurrent();
      await getStorage().putFromFile(webKey, tmpPath, { contentType: 'video/mp4' });
      await attempt.assertCurrent();
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
    const published = await mediaAttempts.guard(attempt, db, true).update({
      web_path: webKey, web_status: 'complete', web_started_at: null, web_error: null,
    });
    if (!published) {
      await getStorage().delete(webKey).catch(() => {});
      logger.info(`videoRendition: photo ${photoId} changed during the transcode, dropped ${webKey}`);
      return 'superseded';
    }
    // The copy an earlier attempt or source left behind is unreferenced now.
    if (photo.web_path && photo.web_path !== webKey) await getStorage().delete(photo.web_path).catch(() => {});
    logger.info(`videoRendition: wrote ${webKey} for photo ${photoId} (${remuxed ? 'metadata-free remux, ' : ''}${probed.videoCodec}/${probed.audioCodec || 'no audio'}, ${probed.majorBrand || probed.formatName}${toneMap ? ', HDR tone-mapped' : ''})`);
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
  STRIP_SETTING_KEY,
  isEnabled,
  isStripEnabled,
  queuesVideos,
  clearCache,
  backfillPending,
  queueForMetadataStrip,
  requeueStranded,
  webKeyFor,
  hasFaststart,
  probe,
  playedStreamIndexes,
  playsInBrowser,
  transcodeOptions,
  remuxOptions,
  isHdr,
  canToneMap,
  _resetToneMapSupportForTests,
  HDR_TO_SDR_FILTER,
  transcode,
  renderWebCopy,
  deleteWebCopy,
};
