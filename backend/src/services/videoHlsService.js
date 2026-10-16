/**
 * Adaptive video streaming (issue 1733, D4).
 *
 * Off by default: a ladder costs a transcode per video and roughly as much
 * disk again, so `general_video_adaptive_streaming` has to be switched on.
 * The queue (videoHlsQueue.js) claims rows with hls_status = 'pending' and
 * calls renderLadder below, which writes H.264/AAC HLS with fMP4 segments
 * (what Safari plays natively and hls.js plays without transmuxing) under
 *
 *   hls/<photoId>/<attemptId>/master.m3u8
 *   hls/<photoId>/<attemptId>/<rung>/index.m3u8, init.mp4, seg_00000.m4s ...
 *
 * through the storage backend. The attempt id in the key keeps attempts
 * apart, exactly as for the web copy (videoRenditionService.webKeyFor).
 * Nothing here touches the photo's other columns: a video without a ladder
 * plays as it always did.
 *
 * Tunables (env, all optional):
 *   VIDEO_HLS_MAX_DURATION_SECONDS  default 1800; longer videos are skipped
 *   VIDEO_HLS_MAX_SOURCE_MIB        default 4096; larger videos are skipped
 */

const path = require('path');
const fsp = require('fs').promises;
const os = require('os');
const mediaProcesses = require('./mediaProcessService');
const { configuration: mediaPolicy, renditionBudget, refusal } = require('./mediaProcessPolicy');
const { db } = require('../database/db');
const logger = require('../utils/logger');
const { getStorage } = require('./storage');
const { IS_VIDEO_SQL } = require('../utils/mediaTypeSql');
const mediaAttempts = require('./mediaAttemptService');
const { isHdr, canToneMap, HDR_TO_SDR_FILTER } = require('./videoRenditionService');

const SETTING_KEY = 'general_video_adaptive_streaming';
const CACHE_TTL_MS = 60_000;

const SEGMENT_SECONDS = 6;
const AUDIO_BITRATE = 128000;
// Short edge and video bitrate ceiling of each rung.
const LADDER = [
  { height: 480, bitrate: 1200000 },
  { height: 720, bitrate: 2800000 },
  { height: 1080, bitrate: 5000000 },
];

const positiveEnv = (name, fallback) => {
  const value = parseInt(process.env[name] || '', 10);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
};
const MAX_DURATION_SECONDS = positiveEnv('VIDEO_HLS_MAX_DURATION_SECONDS', 1800);
const MAX_SOURCE_BYTES = positiveEnv('VIDEO_HLS_MAX_SOURCE_MIB', 4096) * 1024 * 1024;

// The only names a request can reach. The photo id comes from the route and
// the attempt id from the row, never from these.
const RUNG_NAME = /^\d{2,4}p$/;
const SEGMENT_NAME = /^(?:init\.mp4|seg_\d{5}\.m4s)$/;
const LADDER_PATH = /^hls\/(\d+)\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONTENT_TYPES = { '.m3u8': 'application/vnd.apple.mpegurl', '.mp4': 'video/mp4', '.m4s': 'video/iso.segment' };

let cachedEnabled = false;
let cacheExpiresAt = 0;

/** The setting, cached 60 s like the web copy's. */
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
    logger.error('Failed to read the adaptive streaming setting:', error.message);
    cachedEnabled = false;
  }
  cacheExpiresAt = Date.now() + CACHE_TTL_MS;
  return cachedEnabled;
}

function clearCache() {
  cacheExpiresAt = 0;
}

/**
 * Queue every video nobody has looked at yet; with `retryFailed` (the
 * setting was just switched on) also those whose last attempt failed. One
 * UPDATE: the queue probes each video when its turn comes. Returns the
 * number of rows queued.
 */
async function queuePending({ retryFailed = false } = {}) {
  const { formatBoolean } = require('../utils/dbCompat');
  return db('photos')
    // An archived gallery's originals are in its zip, not in storage.
    .whereNotIn('event_id', db('events').select('id').where('is_archived', formatBoolean(true)))
    .whereRaw(IS_VIDEO_SQL)
    .where(function () {
      this.whereNull('hls_status');
      if (retryFailed) this.orWhere('hls_status', 'failed');
    })
    .where(function () {
      this.where('processing_status', 'complete').orWhereNull('processing_status');
    })
    .update({ hls_status: 'pending', hls_error: null, hls_started_at: null, hls_attempts: 0, hls_retry_at: null });
}

const even = value => Math.max(2, 2 * Math.round(value / 2));

/**
 * The rungs for one source: none above its short edge (no upscaling), none
 * above its bitrate, and one at its own size when it is smaller than the
 * lowest rung. A rung the bitrate cap leaves no better than the one above it
 * is dropped: two renditions at one bitrate give a player nothing to choose.
 */
function selectLadder({ width, height, bitrate } = {}) {
  const shortEdge = Math.min(Number(width) || 0, Number(height) || 0);
  if (!shortEdge) return [];
  let rungs = LADDER.filter(rung => rung.height <= shortEdge);
  // Rounded down to an even number: H.264 needs one, and up would upscale.
  if (!rungs.length) rungs = [{ height: Math.max(2, 2 * Math.floor(shortEdge / 2)), bitrate: LADDER[0].bitrate }];
  const ceiling = Number(bitrate) > 0 ? Number(bitrate) : Infinity;
  const landscape = Number(width) >= Number(height);
  const selected = [];
  for (const rung of [...rungs].reverse()) {
    const capped = Math.floor(Math.min(rung.bitrate, ceiling));
    if (selected.length && capped >= selected[0].bitrate) continue;
    const long = even((Math.max(width, height) * rung.height) / shortEdge);
    selected.unshift({ name: `${rung.height}p`, height: rung.height, bitrate: capped,
      width: landscape ? long : rung.height, outputHeight: landscape ? rung.height : long });
  }
  return selected;
}

/**
 * ffmpeg's arguments after the input, in one place so the test can pin them.
 * One decode feeds every rung (and one tone-mapping pass for an HDR source,
 * the decision taken for the web copy). Each scale sets the short edge and
 * keeps the aspect ratio; ffmpeg applies the rotation tag on input, so the
 * expression sees the picture the way it is shown. Keyframes are forced on
 * the segment boundary so every rung cuts at the same instants.
 */
function transcodeOptions(rungs, outDir, { toneMap = false, threads = 1 } = {}) {
  const source = `[0:v:0]${toneMap ? `${HDR_TO_SDR_FILTER},` : ''}`;
  const scale = rung => `scale=w='if(gt(iw,ih),-2,${rung.height})':h='if(gt(iw,ih),${rung.height},-2)'`;
  const graph = rungs.length === 1
    ? `${source}${scale(rungs[0])}[v0]`
    : `${source}split=${rungs.length}${rungs.map((_, i) => `[s${i}]`).join('')};${rungs.map((rung, i) => `[s${i}]${scale(rung)}[v${i}]`).join(';')}`;
  const perEncoder = Math.max(1, Math.floor(threads / rungs.length));
  const args = ['-filter_complex_threads', String(threads), '-filter_complex', graph];
  rungs.forEach((rung, i) => {
    const dir = path.join(outDir, rung.name);
    args.push(
      '-map', `[v${i}]`, '-map', '0:a:0?', '-sn', '-dn',
      // Each output gets none of the source's metadata (location, artist,
      // device tags), which would otherwise land in every rung's init.mp4.
      '-map_metadata', '-1', '-map_chapters', '-1',
      '-c:v', 'libx264', '-preset', 'veryfast', '-profile:v', 'high', '-pix_fmt', 'yuv420p',
      '-crf', '23', '-maxrate', String(rung.bitrate), '-bufsize', String(rung.bitrate * 2),
      '-force_key_frames', `expr:gte(t,n_forced*${SEGMENT_SECONDS})`, '-sc_threshold', '0',
      ...(toneMap ? ['-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709'] : []),
      '-c:a', 'aac', '-b:a', String(AUDIO_BITRATE), '-ac', '2',
      '-threads', String(perEncoder),
      '-f', 'hls', '-hls_time', String(SEGMENT_SECONDS), '-hls_playlist_type', 'vod',
      '-hls_segment_type', 'fmp4', '-hls_flags', 'independent_segments',
      '-hls_fmp4_init_filename', 'init.mp4',
      '-hls_segment_filename', path.join(dir, 'seg_%05d.m4s'),
      path.join(dir, 'index.m3u8'),
    );
  });
  return args;
}

/**
 * What a rung's init segment says it holds: the RFC 6381 codec string and
 * the coded picture size, read from the avc1 sample entry and its avcC box.
 * A player picks and switches rungs by these, so they come from the file
 * ffmpeg wrote and not from what it was asked for. Null for anything that is
 * not the H.264 (and AAC) this service encodes.
 */
function readInitSegment(buffer) {
  // From the sample description on: 'avc1' is also a brand name in ftyp.
  const description = buffer.indexOf('stsd', 0, 'latin1');
  const entry = description < 0 ? -1 : buffer.indexOf('avc1', description, 'latin1');
  const config = entry < 0 ? -1 : buffer.indexOf('avcC', entry, 'latin1');
  if (entry < 0 || config < 0 || config + 8 > buffer.length || entry + 32 > buffer.length) return null;
  const hex = value => value.toString(16).padStart(2, '0');
  // avcC: version, profile, constraint flags, level.
  const video = `avc1.${hex(buffer[config + 5])}${hex(buffer[config + 6])}${hex(buffer[config + 7])}`;
  // Sample entry: 6 reserved, 2 data reference, 16 predefined, then width, height.
  const width = buffer.readUInt16BE(entry + 28);
  const height = buffer.readUInt16BE(entry + 30);
  if (!width || !height) return null;
  // The encoder is ffmpeg's AAC at its default profile: AAC-LC.
  const audio = buffer.indexOf('mp4a', 0, 'latin1') >= 0 ? ',mp4a.40.2' : '';
  return { codecs: `${video}${audio}`, width, height };
}

/**
 * The master playlist. `averages` maps a rung name to its measured bits per
 * second, `inits` to what readInitSegment found: with it the entry carries
 * CODECS and the real RESOLUTION, without it the size the rung was asked for.
 */
function buildMasterPlaylist(rungs, { audio = true, averages = {}, inits = {} } = {}) {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-INDEPENDENT-SEGMENTS'];
  for (const rung of rungs) {
    const peak = Math.round((rung.bitrate + (audio ? AUDIO_BITRATE : 0)) * 1.1);
    const average = Math.min(peak, Math.ceil(averages[rung.name] || 0));
    const init = inits[rung.name];
    lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${peak}${average ? `,AVERAGE-BANDWIDTH=${average}` : ''}`
      + `,RESOLUTION=${init ? `${init.width}x${init.height}` : `${rung.width}x${rung.outputHeight}`}`
      + `${init ? `,CODECS="${init.codecs}"` : ''}`,
    `${rung.name}/index.m3u8`);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * A stored playlist as the player gets it. Every URI must be one this
 * service writes (a relative rung playlist in the master, a segment or the
 * init file in a rung), and gets `query` appended: the cache-buster and the
 * admin-preview flag ride along from the request for the playlist to every
 * request it leads to. Anything else in a URI position is refused.
 */
function rewritePlaylist(text, kind, query = '') {
  const suffix = query ? `?${query}` : '';
  const allowed = kind === 'master' ? /^\d{2,4}p\/index\.m3u8$/ : SEGMENT_NAME;
  const check = uri => {
    if (!allowed.test(uri)) throw new Error(`Unexpected URI in ${kind} playlist`);
    return `${uri}${suffix}`;
  };
  return String(text).split(/\r?\n/).map((line) => {
    const trimmed = line.trim();
    if (!trimmed) return '';
    if (!trimmed.startsWith('#')) return check(trimmed);
    if (!/URI=/.test(trimmed)) return trimmed;
    if (kind !== 'media' || !trimmed.startsWith('#EXT-X-MAP:')) throw new Error(`Unexpected URI in ${kind} playlist`);
    return trimmed.replace(/URI="([^"]*)"/, (_, uri) => `URI="${check(uri)}"`);
  }).join('\n');
}

/**
 * The storage key of one file of a photo's published ladder, or null. The
 * pointer is a row value: only this photo's own hls/<id>/<attempt> prefix
 * is read, and only names of the shapes this service writes.
 */
function ladderKey(photo, rung, file) {
  const match = LADDER_PATH.exec(photo?.hls_path || '');
  if (!match || match[1] !== String(photo.id) || photo.hls_status !== 'complete') return null;
  if (rung === undefined) return file === 'master.m3u8' ? `${photo.hls_path}/master.m3u8` : null;
  if (!RUNG_NAME.test(rung) || (file !== 'index.m3u8' && !SEGMENT_NAME.test(file))) return null;
  return `${photo.hls_path}/${rung}/${file}`;
}

/** The keys under `prefix`, except those under `keep`. */
async function keysUnder(prefix, keep = null) {
  const storage = getStorage();
  // The slash confines an object store's listing to this prefix: 'hls/1'
  // would fetch hls/10/, hls/100/ ... as well, to be dropped below. The local
  // backend walks a directory and builds its keys from the name as given.
  return (await storage.list(storage.kind() === 'local' ? prefix : `${prefix}/`)).map(entry => entry.key)
    .filter(key => key.startsWith(`${prefix}/`) && !(keep && key.startsWith(`${keep}/`)));
}

/** Delete `keys`, all of them under `prefix`. */
async function removeKeys(prefix, keys) {
  const storage = getStorage();
  let cursor = 0;
  const worker = async () => {
    while (cursor < keys.length) await storage.delete(keys[cursor++]).catch(() => {});
  };
  await Promise.all(Array.from({ length: Math.min(8, keys.length) }, worker));
  // On local disk the keys were files in directories of their own; what is
  // empty now goes too, or every deleted video leaves a small tree behind.
  if (storage.kind() === 'local') await pruneEmptyDirs(storage.resolveLocalPath(prefix));
}

/** Delete every object under `prefix`. */
async function removeUnder(prefix) {
  await removeKeys(prefix, await keysUnder(prefix));
}

/** rmdir, bottom-up, every directory under `dir` (and `dir`) that holds nothing. */
async function pruneEmptyDirs(dir) {
  const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => null);
  if (!entries) return;
  for (const entry of entries) if (entry.isDirectory()) await pruneEmptyDirs(path.join(dir, entry.name));
  // Fails, and is meant to, on a directory that still has something in it.
  await fsp.rmdir(dir).catch(() => {});
}

/**
 * Remove a photo's ladder files, every attempt's. For the delete, archive
 * and replace paths.
 */
async function deleteLadder(photo) {
  if (!photo?.id || (!photo.hls_status && !photo.hls_path)) return;
  await removeUnder(`hls/${Number(photo.id)}`)
    .catch(error => logger.warn(`videoHls: could not remove the ladder of photo ${photo.id}: ${error.message}`));
}

/**
 * A photo's ladder attempts as they are now, for a caller that resets the
 * row before it removes them (a replacement): resolves the function that
 * deletes everything under these attempts' prefixes, whatever a worker still
 * busy with one of them wrote in between. An attempt that starts after this
 * (the new file's, on another replica) has a prefix of its own and is kept.
 *
 * The function takes the row as the reset found it, when the caller read it
 * after this listing: an attempt claimed or published in between is removed
 * too.
 */
async function captureLadder(photo) {
  if (!photo?.id) return async () => {};
  const root = `hls/${Number(photo.id)}`;
  const attemptOf = key => key.split('/').slice(0, 3).join('/');
  const warn = error => logger.warn(`videoHls: could not remove the ladder of photo ${photo.id}: ${error.message}`);
  const attempts = new Set();
  // A claimed attempt that has not uploaded anything yet, and a published one.
  const add = (row) => {
    if (row?.hls_attempt_id) attempts.add(`${root}/${row.hls_attempt_id}`);
    if (typeof row?.hls_path === 'string' && row.hls_path.startsWith(`${root}/`)) attempts.add(attemptOf(row.hls_path));
  };
  if (photo.hls_status || photo.hls_path) {
    for (const key of await keysUnder(root).catch((error) => { warn(error); return []; })) attempts.add(attemptOf(key));
    add(photo);
  }
  return async (reset = null) => {
    add(reset);
    if (!attempts.size) return;
    await keysUnder(root).then(keys => removeKeys(root, keys.filter(key => attempts.has(attemptOf(key))))).catch(warn);
  };
}

async function probe(localPath) {
  const metadata = await mediaProcesses.probeVideo(localPath);
  const video = (metadata.streams || []).find(s => s.codec_type === 'video');
  const rotation = Number(video?.side_data_list?.find(item => item.rotation !== undefined)?.rotation ?? video?.tags?.rotate ?? 0);
  const turned = Math.abs(rotation) % 180 === 90;
  return {
    width: (turned ? video?.height : video?.width) || null,
    height: (turned ? video?.width : video?.height) || null,
    bitrate: Number(video?.bit_rate) || Number(metadata.format?.bit_rate) || null,
    duration: Number(metadata.format?.duration) || null,
    audio: (metadata.streams || []).some(s => s.codec_type === 'audio'),
    colorTransfer: video?.color_transfer || null,
  };
}

function transcode(localPath, rungs, outDir, { toneMap = false, duration } = {}) {
  return mediaProcesses.withSnapshot(localPath, 'rendition', async (snapshot, details) => {
    const { policy } = details;
    await mediaProcesses.probeSnapshot(snapshot, details);
    const budget = renditionBudget(duration, policy);
    await mediaProcesses.run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
      ...mediaProcesses.inputOptions(details.format, policy.threads), '-i', snapshot,
      ...transcodeOptions(rungs, outDir, { toneMap, threads: policy.threads })], {
      // The transcode lane, shared with the web copy: posters and probes
      // never wait behind it, and the two kinds never run side by side
      // beyond VIDEO_RENDITION_CONCURRENCY.
      lane: 'long', memoryBytes: policy.transcodeBytes, wallMs: budget.wallMs, cpuSeconds: budget.cpuSeconds,
      fileBytes: policy.outputBytes || 1024 * 1024 * 1024 * 1024,
    });
  });
}

/** The files ffmpeg left for one rung, checked against the names a request may ask for. */
async function rungFiles(dir) {
  const names = (await fsp.readdir(dir)).sort();
  if (!names.includes('index.m3u8') || !names.includes('init.mp4') || !names.some(name => name.startsWith('seg_'))) {
    throw new Error('ffmpeg produced an incomplete rendition');
  }
  for (const name of names) {
    if (name !== 'index.m3u8' && !SEGMENT_NAME.test(name)) throw new Error(`ffmpeg produced an unexpected file: ${name}`);
  }
  // Fails here, not in front of a guest, if the playlist is not what the route serves.
  rewritePlaylist(await fsp.readFile(path.join(dir, 'index.m3u8'), 'utf8'), 'media');
  return names;
}

/**
 * Transcode one claimed video and publish its ladder. Throws on failure so
 * the queue records it; returns the status it wrote otherwise.
 */
async function renderLadder(photoId) {
  const attempt = mediaAttempts.current();
  if (!attempt) throw refusal(`Video ${photoId} has no current execution attempt`, 'MEDIA_ATTEMPT_REQUIRED');
  await attempt.assertCurrent();
  const photo = await db('photos').where({ id: photoId }).first();
  if (!photo) throw new Error(`Photo ${photoId} not found`);
  const event = await db('events').where({ id: photo.event_id }).first();
  if (!event) throw new Error(`Event ${photo.event_id} not found for photo ${photoId}`);

  const skip = async (reason) => {
    await mediaAttempts.guard(attempt, db, true).update({ hls_status: 'skipped', hls_started_at: null, hls_error: reason });
    return 'skipped';
  };
  const isVideo = photo.media_type === 'video'
    || (typeof photo.mime_type === 'string' && photo.mime_type.startsWith('video/'));
  if (!isVideo) return skip(null);
  // Before the source is fetched: a very large video keeps range-serving.
  if (Number(photo.size_bytes) > MAX_SOURCE_BYTES) {
    return skip(`Larger than ${MAX_SOURCE_BYTES / 1048576} MiB (VIDEO_HLS_MAX_SOURCE_MIB)`);
  }

  const { resolvePhotoStorageKey, resolvePhotoFilePath } = require('./photoResolver');
  const { withLocalCopy } = require('./imageProcessor');
  const sourceKey = resolvePhotoStorageKey(event, photo);
  const withSource = sourceKey
    ? fn => withLocalCopy(sourceKey, fn)
    : fn => fn(resolvePhotoFilePath(event, photo));

  return withSource(async (localPath) => {
    const probed = await probe(localPath);
    if (!probed.duration || probed.duration > MAX_DURATION_SECONDS) {
      return skip(probed.duration
        ? `Longer than ${MAX_DURATION_SECONDS} s (VIDEO_HLS_MAX_DURATION_SECONDS)`
        : 'Duration unknown');
    }
    const rungs = selectLadder(probed);
    if (!rungs.length) return skip('Dimensions unknown');

    const hdr = isHdr(probed);
    const toneMap = hdr && await canToneMap();
    if (hdr && !toneMap) {
      logger.warn(`videoHls: photo ${photoId} is HDR (${probed.colorTransfer}) but this ffmpeg lacks zscale/tonemap; the ladder is not tone-mapped`);
    }

    const prefix = `hls/${photo.id}/${attempt.id}`;
    const storage = getStorage();
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'picpeak-hls-'));
    let uploaded = false;
    try {
      for (const rung of rungs) await fsp.mkdir(path.join(tmpDir, rung.name));
      await transcode(localPath, rungs, tmpDir, { toneMap, duration: probed.duration });

      const files = [];
      const averages = {};
      const inits = {};
      let total = 0;
      for (const rung of rungs) {
        let bytes = 0;
        for (const name of await rungFiles(path.join(tmpDir, rung.name))) {
          const local = path.join(tmpDir, rung.name, name);
          const { size } = await fsp.stat(local);
          if (name !== 'index.m3u8') bytes += size;
          files.push({ key: `${prefix}/${rung.name}/${name}`, local });
        }
        averages[rung.name] = (bytes * 8) / probed.duration;
        inits[rung.name] = readInitSegment(await fsp.readFile(path.join(tmpDir, rung.name, 'init.mp4')));
        total += bytes;
      }
      const { outputBytes } = mediaPolicy();
      if (outputBytes && total > outputBytes) throw refusal(`Video ladder is larger than ${outputBytes / 1048576} MiB (MEDIA_MAX_VIDEO_OUTPUT_MIB)`);
      const master = path.join(tmpDir, 'master.m3u8');
      await fsp.writeFile(master, buildMasterPlaylist(rungs, { audio: probed.audio, averages, inits }));
      // The master goes last: a ladder is only ever read through it.
      files.push({ key: `${prefix}/master.m3u8`, local: master });

      uploaded = true;
      for (const file of files) {
        // Before every file: a ladder is hundreds of objects, and an attempt
        // that was cancelled (a shutdown) or lost its row stops here rather
        // than after the last of them.
        await attempt.assertCurrent();
        await storage.putFromFile(file.key, file.local, { contentType: CONTENT_TYPES[path.extname(file.key)] });
      }
      await attempt.assertCurrent();
      // What earlier attempts or an earlier source left behind, listed
      // before the publish: at this point every other prefix is older than
      // this attempt. Listed after it, a newer attempt (the video replaced
      // right behind the publish, claimed by another replica) could already
      // be writing its own prefix, and this cleanup would take that.
      const ladderRoot = `hls/${photo.id}`;
      const leftovers = await keysUnder(ladderRoot, prefix).catch((error) => {
        logger.warn(`videoHls: could not list the earlier ladders of photo ${photoId}: ${error.message}`);
        return [];
      });
      // Publish only against this worker's claim, as the web copy does: a
      // replacement, a delete or the janitor may have moved the row on.
      const published = await mediaAttempts.guard(attempt, db, true).update({
        hls_path: prefix, hls_status: 'complete', hls_started_at: null, hls_error: null,
      });
      if (!published) {
        await removeUnder(prefix).catch(() => {});
        logger.info(`videoHls: photo ${photoId} changed during the transcode, dropped ${prefix}`);
        return 'superseded';
      }
      uploaded = false;
      // They are unreferenced now.
      await removeKeys(ladderRoot, leftovers)
        .catch(error => logger.warn(`videoHls: could not remove the earlier ladders of photo ${photoId}: ${error.message}`));
      logger.info(`videoHls: wrote ${prefix} for photo ${photoId} (${rungs.map(rung => rung.name).join(', ')}${toneMap ? ', HDR tone-mapped' : ''}, ${Math.round(total / 1048576)} MiB)`);
      return 'complete';
    } catch (error) {
      // Partial output never stays: the key carries this attempt's id, so
      // these are this attempt's objects and no other's.
      if (uploaded) await removeUnder(prefix).catch(() => {});
      throw error;
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  });
}

module.exports = {
  SETTING_KEY,
  SEGMENT_NAME,
  RUNG_NAME,
  MAX_DURATION_SECONDS,
  isEnabled,
  clearCache,
  queuePending,
  selectLadder,
  transcodeOptions,
  readInitSegment,
  buildMasterPlaylist,
  rewritePlaylist,
  ladderKey,
  deleteLadder,
  captureLadder,
  probe,
  transcode,
  renderLadder,
};
