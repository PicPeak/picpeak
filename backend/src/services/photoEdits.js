/**
 * Non-destructive photo edits (issue 2619).
 *
 * An edit is a small JSON parameter set on the photo row (photos.edit_params,
 * see utils/photoEditMath.js); the original file is never rewritten. What
 * guests see and download is a full-size JPEG rendered from the original and
 * the params, stored under `edits/` and named in photos.edit_render_path. It
 * is a cache: rendered when an edit is saved, and again whenever it is
 * missing (a restore, an import, a lost file) through ensureEditedSource, so
 * archives and backups only need to carry the params.
 *
 * Every guest-facing reader goes through one of two doors:
 *   - the rendition code (thumbnails, previews, heroes, tiers) asks
 *     ensureEditedSource for the file to cut from;
 *   - the download and delivery routes take deliveredPhoto(photo), a copy of
 *     the row that names the edited file (resolvePhotoStorageKey honours it),
 *     a JPEG type and a `.jpg` name.
 * Internal readers (backups, archives, faces, hashes, the admin's original
 * download) keep resolving the original from the row as before.
 *
 * photos.edit_rev counts saves; edit_applied_rev is the revision whose
 * renditions are in place. Saving bumps edit_rev and asks the background pass
 * (below) to render the file, rebuild the renditions, drop the watermark copy
 * and the prebuilt gallery ZIP, then raise edit_applied_rev. The queue is the
 * rows themselves, so a restart resumes it, and every step is guarded by the
 * revision it was started for: a save that lands meanwhile wins, and a
 * render of the older revision drops its own file instead of being recorded.
 *
 * Existing edits keep applying while the photoEditor feature flag is off;
 * the flag only hides the editor.
 *
 * Tunables (env, all optional):
 *   PHOTO_EDIT_MAX_PIXELS        default 36000000, the largest edited render
 *                                (a larger source is scaled down on decode)
 *   PHOTO_EDIT_JPEG_QUALITY      default 92, the edited JPEG's quality
 *   PREVIEW_REGEN_CONCURRENCY    photos applied at once (default 1), shared
 *                                with the preview regeneration
 *   PHOTO_EDIT_DELAY_MS          default 5000, wait after boot
 */

const crypto = require('crypto');
const pLimit = require('p-limit');
const { db } = require('../database/db');
const logger = require('../utils/logger');
const math = require('../utils/photoEditMath');
const { getStorage } = require('./storage');
const { livePhotos, wherePhotoProcessed } = require('../utils/photoVisibility');
const { createInterruptibleSleep } = require('../utils/interruptibleSleep');
const maintenanceJobs = require('./maintenanceJobState');
const loadGovernor = require('./loadGovernor');

const JOB_NAME = 'photo_edit_apply';
const EDIT_COLUMNS = ['edit_params', 'edit_rev', 'edit_applied_rev', 'edit_render_path', 'edit_width', 'edit_height'];
// RENDER_KEY: the only keys an edited render is ever read from or deleted at;
// a row is no authority for anything else (a crafted import could name an
// original). DELIVERY_KEY marks a delivered copy of a row (deliveredPhoto).
const { RENDER_KEY, DELIVERY_KEY, deliveredKey } = require('./photoResolver');
const BASE_LONG_EDGE = 1920;
const BATCH = 100;
// Photos a default develop saves in one transaction.
const DEVELOP_CHUNK = 200;
const RETRY_MS = 10 * 60 * 1000;
const RETRY_CLAIM_MS = 10 * 60 * 1000;

const intEnv = (name, fallback) => {
  const value = parseInt(process.env[name] || '', 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};
const maxPixels = () => intEnv('PHOTO_EDIT_MAX_PIXELS', 36000000);
const jpegQuality = () => Math.min(100, Math.max(60, intEnv('PHOTO_EDIT_JPEG_QUALITY', 92)));
const concurrency = () => Math.min(8, intEnv('PREVIEW_REGEN_CONCURRENCY', 1));

const isVideoRow = (photo) => photo.media_type === 'video' || photo.type === 'video'
  || String(photo.mime_type || '').startsWith('video/');

// Every column that names an edit file (migration 380): what a delete collects.
const EDIT_FILE_COLUMNS = ['edit_render_path', 'edit_applied_render_path'];

// The applied revision's edit, size and render (migration 380).
const APPLIED_COLUMNS = ['edit_applied_params', 'edit_applied_width', 'edit_applied_height', 'edit_applied_render_path'];

/** The row as its applied revision: what its renditions show while a newer edit is pending. */
function appliedView(row) {
  return {
    ...row,
    edit_params: row.edit_applied_params ?? null,
    edit_rev: Number(row.edit_applied_rev) || 0,
    edit_render_path: row.edit_applied_render_path ?? null,
    edit_width: row.edit_applied_width ?? null,
    edit_height: row.edit_applied_height ?? null,
    edit_view: 'applied',
  };
}

/**
 * The row renditions (thumbnails, previews, hero, their tiers) are cut for
 * (issue 2619): while a newer save is still being applied, its applied
 * revision, which guests' URLs (e=) and face boxes name; the pending edit
 * shows once the background pass applies it. A row marked edit_view
 * 'current' (the pass building that revision's renditions) stays as it is.
 */
async function renditionView(photo) {
  if (!photo || photo.edit_view || isVideoRow(photo) || !(Number(photo.edit_rev) > Number(photo.edit_applied_rev))) return photo;
  const missing = APPLIED_COLUMNS.filter((column) => !(column in photo));
  const row = missing.length ? await db('photos').where({ id: photo.id }).first(missing) : {};
  return appliedView({ ...photo, ...(row || {}) });
}

/**
 * Whether guests are kept from this photo's picture for now (issue 2619): a
 * saved edit that changes its geometry (a crop, a turn, a flip, a
 * straighten) failed to render, so its previews still show what the crop
 * may have been made to remove, and keep doing so while the apply keeps
 * failing. Guests get 503 until it renders; the admin sees it as it is.
 * A pending edit that has not failed yet keeps serving the applied one.
 */
async function withheldFromGuests(photo) {
  if (!photo || photo.id == null || isVideoRow(photo)) return false;
  const columns = ['edit_params', 'edit_rev', 'edit_applied_rev', 'edit_applied_params', 'edit_failed_rev'];
  const missing = columns.filter((column) => !(column in photo));
  const row = missing.length ? { ...photo, ...(await db('photos').where({ id: photo.id }).first(missing)) } : photo;
  if (row.edit_failed_rev == null || Number(row.edit_failed_rev) !== Number(row.edit_rev)) return false;
  if (!(Number(row.edit_rev) > Number(row.edit_applied_rev))) return false;
  const geometry = (stored) => {
    const params = math.parseStoredParams(stored);
    return JSON.stringify(math.GEOMETRY_KEYS.map((key) => (params ? params[key] : math.DEFAULT_PARAMS[key])));
  };
  return geometry(row.edit_params) !== geometry(row.edit_applied_params);
}

/** The row with its edit columns, read once when a caller's select left them out. */
async function withEditColumns(photo, { source = false } = {}) {
  if (!photo || photo.id == null || isVideoRow(photo)) return photo;
  // `source`: the columns sourceTag reads too, for whoever checks a render.
  const missing = [...EDIT_COLUMNS, ...(source ? SOURCE_COLUMNS : [])].filter((column) => !(column in photo));
  if (!missing.length) return photo;
  const row = await db('photos').where({ id: photo.id }).first(missing);
  return row ? { ...photo, ...Object.fromEntries(missing.map((column) => [column, row[column]])) } : photo;
}

// What identifies the original's bytes: a replaced file moves the path, a
// file rewritten on a share keeps it but changes size and mtime, a new
// processing attempt reads it again.
const SOURCE_COLUMNS = ['path', 'external_relpath', 'size_bytes', 'source_mtime_ms', 'processing_attempt_id'];

/**
 * A short tag of the original a render or develop preview was made from. It
 * is in their names, so one of other bytes (an external file rewritten in
 * place, which keeps the edit) is never served: it is rendered again.
 */
function sourceTag(photo) {
  const identity = [photo.id, ...SOURCE_COLUMNS.map((column) => photo[column] ?? null)].map((v) => (v == null ? null : String(v)));
  return crypto.createHash('sha256').update(JSON.stringify(identity)).digest('hex').slice(0, 10);
}

/** The photo's edit, or null for none. */
const paramsOf = (photo) => (photo && !isVideoRow(photo) ? math.parseStoredParams(photo.edit_params) : null);

/** Whether the row (with its edit columns) shows guests an edit. */
const isEdited = (photo) => Boolean(paramsOf(photo));

/** Whether `key` is an edited render of this photo, of its current revision when `rev` is given. */
/** Whether `key` is an edited render of this photo; with `rev`, of that revision and the current source. */
function isRenderKeyOf(photo, key, rev) {
  const match = typeof key === 'string' && RENDER_KEY.exec(key);
  return Boolean(match && Number(match[1]) === Number(photo.id)
    && (rev === undefined || key.startsWith(`edits/edit_p${photo.id}_r${rev}_s${sourceTag(photo)}_`)));
}

// ------------------------------------------------------------------ render

/**
 * Open the photo's original as something sharp can read (a RAW's embedded
 * preview, a decoded HEIC) and hand its local path to `fn`; with `raw`, the
 * file itself (for the RAW develop).
 */
async function withOriginal(photo, fn, { raw = false } = {}) {
  const { resolvePhotoStorageKey, resolvePhotoFilePath } = require('./photoResolver');
  const { withLocalCopy, withProcessableImage } = require('./imageProcessor');
  const event = await db('events').where({ id: photo.event_id }).first();
  if (!event) throw new Error(`Event ${photo.event_id} of photo ${photo.id} not found`);
  const original = { ...photo };
  delete original[DELIVERY_KEY];
  const key = resolvePhotoStorageKey(event, original);
  const open = async (localPath, sourceName) => {
    if (raw) return fn(localPath, sourceName);
    const proc = await withProcessableImage(localPath, sourceName);
    try {
      return await fn(proc.path);
    } finally {
      await proc.cleanup();
    }
  };
  if (key) return withLocalCopy(key, (localPath) => open(localPath, key));
  return open(resolvePhotoFilePath(event, original), original.external_relpath || original.filename);
}

/** Interleaved 8-bit RGB from a raw decode of 1-4 channels. */
function toRgb(data, info) {
  if (info.channels === 3) return data;
  const pixels = info.width * info.height;
  const rgb = Buffer.alloc(pixels * 3);
  for (let i = 0; i < pixels; i++) {
    const s = i * info.channels;
    const grey = info.channels < 3;
    rgb[i * 3] = data[s];
    rgb[i * 3 + 1] = grey ? data[s] : data[s + 1];
    rgb[i * 3 + 2] = grey ? data[s] : data[s + 2];
  }
  return rgb;
}

/** photoEditMath.renderEdit on a worker thread; `src` is handed over, not copied. */
function renderInWorker(src, width, height, channels, params, options) {
  const { Worker } = require('worker_threads');
  return new Promise((resolve, reject) => {
    const worker = new Worker(require('path').join(__dirname, 'photoEditWorker.js'), {
      workerData: {
        buffer: src.buffer, byteOffset: src.byteOffset, length: src.length, bits: src.BYTES_PER_ELEMENT * 8,
        width, height, channels, params, options,
      },
      transferList: [src.buffer],
    });
    worker.once('message', (out) => resolve({
      width: out.width, height: out.height, data: Buffer.from(out.buffer, out.byteOffset, out.length),
    }));
    worker.once('error', reject);
    worker.once('exit', (code) => { if (code !== 0) reject(new Error(`The edit render stopped (${code})`)); });
  });
}

/**
 * The full-size edited JPEG of a photo.
 *
 * A camera RAW, where LibRaw's dcraw_emu is installed, is developed from its
 * sensor data (rawDevelop: 16-bit linear, as-shot white balance, highlights
 * rebuilt), half-size when the sensor is far larger than the render may be;
 * the edit then runs on the linear data with the RAW look. Anything else, and
 * a RAW without dcraw_emu, is decoded upright by sharp (a RAW through its
 * embedded preview), scaled down on decode when it is larger than
 * PHOTO_EDIT_MAX_PIXELS.
 *
 * The pixel pass runs on a worker thread and streams over the output twice
 * instead of keeping a full-size intermediate. Memory: the decoded source (3
 * bytes a pixel, 6 for a RAW develop) and the 3-byte output, plus four Int16
 * planes of the output (8 bytes a pixel) while detail, shadows/highlights or
 * whites/blacks are in the edit: about 11 bytes an output pixel beyond the
 * source. Metadata: an allowlist of the source's (camera, exposure, date,
 * author, copyright, caption; imageProcessor.withAllowedMetadata), for a RAW
 * from its container.
 */
async function renderEditedJpeg(photo, params, { interactive = false } = {}) {
  const sharp = require('./isolatedSharp');
  const rawDevelop = require('./rawDevelop');
  const imageProcessor = require('./imageProcessor');
  const limit = maxPixels();
  const encode = async (out) => sharp(out.data, { raw: { width: out.width, height: out.height, channels: 3 }, interactive })
    .jpeg({ quality: jpegQuality(), chromaSubsampling: '4:4:4' }).toBuffer();
  const decoded = async (sourcePath, metadataSource) => {
    const metadata = await sharp(sourcePath, { failOn: 'none', interactive }).metadata();
    const turned = (metadata.orientation || 1) >= 5;
    const width = turned ? metadata.height : metadata.width;
    const height = turned ? metadata.width : metadata.height;
    let chain = sharp(sourcePath, { failOn: 'none', interactive }).rotate();
    if (width * height > limit) {
      const scale = Math.sqrt(limit / (width * height));
      chain = chain.resize(Math.max(1, Math.floor(width * scale)), Math.max(1, Math.floor(height * scale)), { fit: 'inside' });
    }
    const { data, info } = await chain.flatten({ background: '#ffffff' }).raw({ depth: 'uchar' }).toBuffer({ resolveWithObject: true });
    const out = await renderInWorker(toRgb(data, info), info.width, info.height, 3, params, { maxPixels: limit });
    return {
      buffer: await imageProcessor.withAllowedMetadata(metadataSource, await encode(out)),
      width: out.width,
      height: out.height,
    };
  };
  const developable = rawDevelop.isRawPhoto(photo) && await rawDevelop.isAvailable();
  return withOriginal(photo, async (localPath, sourceName) => {
    // The name only proposes a RAW; the bytes decide (a renamed JPEG is decoded as one).
    if (developable && !(await rawDevelop.isOrdinaryImageFile(localPath))) {
      const info = await rawDevelop.identify(localPath);
      const half = Boolean(info.width && info.height && info.width * info.height > 1.5 * limit);
      const image = await rawDevelop.developLinear(localPath, { half, nr: params.nr, size: info });
      const out = await renderInWorker(image.data, image.width, image.height, 3, params,
        { maxPixels: limit, linear: true, exposureBias: info.exposureBias });
      // The allowlisted tags of the container, none of its preview images.
      return { buffer: await imageProcessor.withAllowedMetadata(localPath, await encode(out)), width: out.width, height: out.height };
    }
    const proc = await imageProcessor.withProcessableImage(localPath, sourceName);
    try {
      return await decoded(proc.path, localPath);
    } finally {
      await proc.cleanup();
    }
  }, { raw: true });
}

/** The unedited photo, upright, at most `longEdge` long: the editor's base and the face scan's input for an edited photo. */
async function originalPreviewJpeg(photo, { longEdge = BASE_LONG_EDGE, interactive = false } = {}) {
  const sharp = require('./isolatedSharp');
  return withOriginal(photo, (sourcePath) => sharp(sourcePath, { failOn: 'none', interactive })
    .rotate()
    .resize(longEdge, longEdge, { fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#ffffff' })
    .jpeg({ quality: 90 })
    .toBuffer());
}

const renderFlights = new Map();
// Full-size renders at once in this process, whoever asks (the background
// pass, a guest download of a photo whose render was lost): each holds a
// decoded photo, so they queue like the preview regeneration.
const renderLimit = pLimit(concurrency());

/**
 * Render the photo's edit of its current revision and record it. Null when
 * a newer save superseded that revision meanwhile (the file is dropped).
 *
 * Published compare-and-set against `photo` as read before the render: only
 * while the row still names the render path that snapshot had. Another
 * replica may have rendered the same revision meanwhile, and a download or
 * an archive may already hold its key; then its render is adopted (when it
 * is of this revision and source) and only this render's own file goes.
 */
async function renderAndRecord(photo, params, options) {
  const { buffer, width, height } = await renderEditedJpeg(photo, params, options);
  const key = `edits/edit_p${photo.id}_r${photo.edit_rev}_s${sourceTag(photo)}_${crypto.randomBytes(6).toString('hex')}.jpg`;
  const storage = getStorage();
  await storage.put(key, buffer);
  // The applied revision's render (an applied view, renditionView) is
  // recorded in its own column; the current one with its size.
  const applied = photo.edit_view === 'applied';
  const [revColumn, pathColumn] = applied ? ['edit_applied_rev', 'edit_applied_render_path'] : ['edit_rev', 'edit_render_path'];
  const before = photo.edit_render_path || null;
  const recorded = await db('photos').where({ id: photo.id, [revColumn]: photo.edit_rev })
    .where((q) => (before ? q.where(pathColumn, before) : q.whereNull(pathColumn)))
    .update(applied ? { [pathColumn]: key } : { [pathColumn]: key, edit_width: width, edit_height: height });
  if (recorded !== 1) {
    await storage.delete(key).catch(() => {});
    const current = await db('photos').where({ id: photo.id }).first([revColumn, pathColumn]);
    const winner = current && Number(current[revColumn]) === Number(photo.edit_rev) ? current[pathColumn] : null;
    return winner && isRenderKeyOf(photo, winner, photo.edit_rev) ? winner : null;
  }
  // The render this one replaced: of an older revision or source, or lost.
  // Only a key of this photo's own render namespace is deleted; a download
  // still streaming it keeps its handle. Never the applied revision's render
  // while it is still applied: renditions are cut from it until the pass
  // applies the new one (and then drops it).
  if (!applied && before) {
    // Of the applied revision itself (nothing pending: the source was
    // rewritten, or the render lost): it is the applied render now too.
    await db('photos').where({ id: photo.id, edit_applied_rev: photo.edit_rev, edit_applied_render_path: before })
      .update({ edit_applied_render_path: key });
  }
  const stillApplied = !applied && before
    && (await db('photos').where({ id: photo.id }).first('edit_applied_render_path'))?.edit_applied_render_path === before;
  if (before && before !== key && !stillApplied && isRenderKeyOf(photo, before)) {
    await storage.delete(before).catch((err) => {
      logger.warn(`Could not remove the superseded edited render ${before} of photo ${photo.id}: ${err.message}`);
    });
  }
  return key;
}

/**
 * The storage key of the photo's edited render for its current revision,
 * rendered now when there is none (one flight per photo and revision in this
 * process); null for a photo without an edit. Throws when the render fails:
 * a caller must never fall back to the original, which the edit may crop.
 */
async function ensureEditedSource(photo, { interactive = false, retryFailed = false, headOnly = false } = {}) {
  photo = await withEditColumns(photo);
  let params = paramsOf(photo);
  if (!params) return null;
  // A revision whose render failed is rendered again by the background pass
  // only (an admin retry asks it to; it marks the rows it rebuilds with
  // edit_retry_failed), never on a request: each would queue another full
  // render on the shared limit and fail again. A render that is there is
  // served whatever failed before it.
  const mayRetry = retryFailed || photo.edit_retry_failed === true || photo.edit_view === 'applied';
  const failedBefore = async () => {
    if (mayRetry) return false;
    const failed = 'edit_failed_rev' in photo ? photo.edit_failed_rev
      : (await db('photos').where({ id: photo.id }).first('edit_failed_rev'))?.edit_failed_rev;
    return failed != null && Number(failed) === Number(photo.edit_rev);
  };
  // The source columns only where there is a render to check.
  photo = await withEditColumns(photo, { source: true });
  for (let attempt = 0; attempt < 3; attempt++) {
    const key = photo.edit_render_path;
    if (isRenderKeyOf(photo, key, photo.edit_rev)) {
      try {
        if (await getStorage().stat(key)) return key;
      } catch (err) {
        if (require('./storage/storageErrors').isStorageUnavailableError(err)) throw err;
      }
    }
    // A HEAD request answers from what is there; it never starts a render.
    if (headOnly) throw Object.assign(new Error(`The edit of photo ${photo.id} is not rendered yet`), { status: 503, code: 'EDIT_PENDING' });
    if (await failedBefore()) {
      throw Object.assign(new Error(`The edit of photo ${photo.id} could not be rendered; it is tried again later`), { status: 503, code: 'EDIT_FAILED' });
    }
    const flightKey = `${photo.edit_view === 'applied' ? 'applied' : 'current'}:${photo.id}:${photo.edit_rev}`;
    let flight = renderFlights.get(flightKey);
    if (!flight) {
      const snapshot = photo;
      const snapshotParams = params;
      flight = renderLimit(() => renderAndRecord(snapshot, snapshotParams, { interactive })).finally(() => renderFlights.delete(flightKey));
      renderFlights.set(flightKey, flight);
    }
    const recorded = await flight;
    if (recorded) return recorded;
    // Superseded: the row has a newer revision (or another replica recorded
    // this one). Read it again and serve what it says now.
    const fresh = await db('photos').where({ id: photo.id }).first([...EDIT_COLUMNS, ...APPLIED_COLUMNS]);
    if (!fresh) return null;
    photo = photo.edit_view === 'applied' ? appliedView({ ...photo, ...fresh }) : { ...photo, ...fresh };
    params = paramsOf(photo);
    if (!params) return null;
  }
  throw Object.assign(new Error(`The edit of photo ${photo.id} kept changing while it was rendered`), { status: 503, code: 'EDIT_BUSY' });
}

/** A file name with `.jpg` in place of its extension. */
const asJpegName = (name) => (name ? `${String(name).replace(/\.[^./\\]*$/, '')}.jpg` : name);

/**
 * The row as guests receive it: for an edited photo, a copy naming the
 * edited render (resolvePhotoStorageKey returns it), a JPEG type and name,
 * the edited size, and no pre-generated watermark copy unless that copy was
 * made from this revision. Unchanged for a photo without an edit.
 */
async function deliveredPhoto(photo, options = {}) {
  if (!photo || isVideoRow(photo)) return photo;
  const row = await withEditColumns(photo);
  if (!paramsOf(row)) return photo;
  let key;
  try {
    key = await ensureEditedSource(row, options);
  } catch (err) {
    if (!options.unavailableOnFailure) throw err;
    // An archive builder skips this photo like any other unreadable file:
    // it is delivered under a render key no file has, never as its original.
    logger.warn(`Photo edit: photo ${row.id} could not be rendered for a download: ${err.message}`);
    key = `edits/edit_p${row.id}_r${Number(row.edit_rev) || 0}_s${'0'.repeat(10)}_${'0'.repeat(12)}.jpg`;
  }
  if (!key) return photo;
  const current = await db('photos').where({ id: row.id }).first(['edit_rev', 'edit_width', 'edit_height', 'watermark_path']);
  return {
    ...row,
    [DELIVERY_KEY]: key,
    edit_rev: current?.edit_rev ?? row.edit_rev,
    filename: asJpegName(row.filename),
    original_filename: asJpegName(row.original_filename),
    mime_type: 'image/jpeg',
    media_type: 'image',
    source_origin: 'managed',
    external_relpath: null,
    size_bytes: null,
    width: current?.edit_width ?? row.edit_width ?? row.width,
    height: current?.edit_height ?? row.edit_height ?? row.height,
    watermark_path: watermarkCopyCurrent(row, current?.watermark_path) ? current.watermark_path : null,
  };
}

/**
 * The row named as deliveredPhoto will name it, without rendering: an
 * edited photo as the JPEG it is delivered as. For archive entry names
 * worked out before the renders run one entry at a time.
 */
function namedAsDelivered(photo) {
  if (!photo || isVideoRow(photo) || !paramsOf(photo)) return photo;
  return { ...photo, filename: asJpegName(photo.filename), original_filename: asJpegName(photo.original_filename) };
}

/** Whether a stored watermark copy was made from the edit of the row's revision (watermarkService.watermarkKey). */
function watermarkCopyCurrent(photo, key) {
  return Boolean(key && String(key).includes(`_e${photo.edit_rev}_`));
}


/**
 * The size listings give a photo, the size of its previews: the applied
 * edit's (issue 2619), which they show until a newer edit is applied, or
 * the original's when no edit is applied.
 */
function deliveredDimensions(photo) {
  if (photo.edit_applied_params && photo.edit_applied_width && photo.edit_applied_height) {
    return { width: Number(photo.edit_applied_width), height: Number(photo.edit_applied_height) };
  }
  return { width: photo.width || null, height: photo.height || null };
}

/**
 * The `e=` part of a guest image URL: the revision whose renditions are in
 * place, so the URL changes when the rebuilt ones land and not before. Empty
 * for a photo never edited, so its URLs stay as they were.
 */
function editQuery(photo) {
  const applied = Number(photo?.edit_applied_rev) || 0;
  return applied > 0 && !isVideoRow(photo) ? `e=${applied}` : '';
}

/**
 * Whether an image request names another revision than the one whose
 * renditions are in place: the answer must not be cached under that URL
 * (as a stale focal point, routes/gallery/media.js).
 */
function editVersionStale(photo, asked) {
  if (isVideoRow(photo)) return false;
  const applied = Number(photo.edit_applied_rev) || 0;
  // A newer edit being applied: nothing is kept under any URL until it lands
  // and the URL moves on (the pass rebuilds the renditions just before).
  if (Number(photo.edit_rev) > applied) return true;
  return String(typeof asked === 'string' ? asked : '') !== (applied > 0 ? String(applied) : '');
}

// -------------------------------------------------------------------- save

const roundPoint = (value) => Math.round(Math.min(1, Math.max(0, value)) * 1000) / 1000;

/**
 * The focal columns after the geometry changes from `before` to `after`. A
 * point set by hand is carried to where it is in the new image (clamped to
 * it); a detected one is cleared so the rebuild detects it again on the
 * edited image. Undefined when nothing moved.
 */
function focalAfterEdit(photo, before, after) {
  const geometry = (p) => JSON.stringify(math.GEOMETRY_KEYS.map((key) => (p ? p[key] : math.DEFAULT_PARAMS[key])));
  if (geometry(before) === geometry(after)) return undefined;
  if (photo.focal_x == null || photo.focal_y == null || photo.focal_source !== 'manual'
      || !(photo.width > 0) || !(photo.height > 0)) {
    return photo.focal_source === 'manual' || photo.focal_x != null
      ? { focal_x: null, focal_y: null, focal_source: null }
      : undefined;
  }
  const w = Number(photo.width);
  const h = Number(photo.height);
  let point = { x: Number(photo.focal_x), y: Number(photo.focal_y) };
  if (before) point = math.mapPointFromEdited(before, w, h, point);
  if (after) point = math.mapPointToEdited(after, w, h, point);
  return { focal_x: roundPoint(point.x), focal_y: roundPoint(point.y), focal_source: 'manual' };
}

/**
 * Save edits: `changes` is [{ photo, params }] with params validated (null
 * resets). One transaction, every row's revision bumped; the background pass
 * renders and rebuilds. Returns the new revisions by photo id.
 *
 * `onlyUnedited`: write only while the row is still the unedited one `photo`
 * was read as (no edit, the same revision); a row that changed meanwhile is
 * left alone and missing from the result. The default RAW develop is queued
 * from such an earlier read and must never replace an edit saved since.
 */
async function saveEdits(changes, { onlyUnedited = false } = {}) {
  const revisions = {};
  const unreachable = [];
  await db.transaction(async (trx) => {
    for (const { photo, params: asked } of changes) {
      // Develop and noise reduction mean nothing for a photo that is no
      // camera RAW; left in, they would re-encode a JPEG for no change.
      const params = asked && !require('./rawDevelop').isRawPhoto(photo) ? { ...asked, develop: false, nr: 0 } : asked;
      const next = params && !math.isIdentity(params) ? params : null;
      const before = paramsOf(photo);
      const update = {
        edit_params: next ? math.canonicalJson(next) : null,
        edit_rev: trx.raw('edit_rev + 1'),
        edit_width: null,
        edit_height: null,
      };
      if (next && photo.width > 0 && photo.height > 0) {
        // The shape guests are shown until the render lands with its exact size.
        const size = math.outputSize(next, Number(photo.width), Number(photo.height), { maxPixels: maxPixels() });
        update.edit_width = size.width;
        update.edit_height = size.height;
      }
      const focal = focalAfterEdit(photo, before, next);
      if (focal) Object.assign(update, focal);
      const target = trx('photos').where({ id: photo.id });
      if (onlyUnedited) target.whereNull('edit_params').where('edit_rev', Number(photo.edit_rev) || 0);
      if (!(await target.update(update))) continue;
      // Thumbnail tier keys name the focal point; once it moves, no key the
      // row gives (and no later cleanup) reaches the ones cut at the old
      // point. Listed from the row as it was, removed once saved.
      if (focal && (focal.focal_x !== photo.focal_x || focal.focal_y !== photo.focal_y || focal.focal_source !== photo.focal_source)) {
        unreachable.push(...tierKeysAtCurrentPoint(photo));
      }
      const row = await trx('photos').where({ id: photo.id }).first('edit_rev');
      revisions[photo.id] = Number(row.edit_rev);
    }
  });
  const storage = getStorage();
  await Promise.all([...new Set(unreachable)].map((key) => storage.delete(key).catch(() => {})));
  // The prebuilt download-all ZIP holds the saved edits' renders: it goes now,
  // not when the render lands, which may never happen if it keeps failing.
  const zip = require('./downloadZipService');
  const events = new Set(changes.filter(({ photo }) => revisions[photo.id] !== undefined).map(({ photo }) => Number(photo.event_id)));
  for (const eventId of events) await zip.invalidateIfBuilt(eventId).catch(() => {});
  requestPass();
  return revisions;
}

/** The thumbnail tiers a row's current focal point names: the original's and every revision's still around. */
function tierKeysAtCurrentPoint(photo) {
  const imageProcessor = require('./imageProcessor');
  return [...imageProcessor.thumbnailTierKeys({ ...photo, edit_params: null }), ...historicalTierKeys(photo)];
}

/**
 * Every edit cache file of a photo row: its edited render and, for a RAW,
 * its develop preview. Read from the row before the row goes (a gallery
 * delete collects them ahead of its transaction).
 */
function editCacheKeys(photo) {
  if (!photo) return [];
  // The tiers of the edit's revisions too: a reset still waiting for the
  // background pass has not dropped them yet.
  const keys = Number(photo.edit_rev) > 0 ? historicalTierKeys(photo) : [];
  for (const column of EDIT_FILE_COLUMNS) {
    if (isRenderKeyOf(photo, photo[column]) && !keys.includes(photo[column])) keys.push(photo[column]);
  }
  const rawDevelop = require('./rawDevelop');
  if (rawDevelop.isRawPhoto(photo)) keys.push(rawDevelop.previewKey(photo));
  return keys;
}

/** Remove a photo's edit cache files (photo delete, archive, replace). Best effort. */
async function deleteEditedRender(photo) {
  if (!photo) return;
  for (const key of editCacheKeys(photo)) {
    await getStorage().delete(key).catch((err) => {
      logger.warn(`Could not remove the edit file ${key} of photo ${photo.id}: ${err.message}`);
    });
  }
}

const AUTO_DEVELOP_SETTING = 'photo_editor_auto_develop_raw';

/** Whether new RAW uploads are developed with the default look (off by default: CPU). */
async function autoDevelopEnabled() {
  const value = await require('../utils/appSettings').getAppSetting(AUTO_DEVELOP_SETTING, false);
  return value === true || value === 'true' || value === 1;
}

/**
 * Queue the default develop for RAW photos that have no edit yet (the batch
 * action and, when the setting is on, every finished RAW upload). Their
 * guests then get a JPEG developed from the sensor data instead of the
 * camera's embedded preview. Returns the ids queued.
 */
async function queueDefaultDevelop(photos) {
  const rawDevelop = require('./rawDevelop');
  const changes = [];
  for (const photo of photos) {
    if (isVideoRow(photo) || paramsOf(photo) || !(await rawDevelop.isRawSource(photo))) continue;
    changes.push({ photo, params: { ...math.DEFAULT_PARAMS, develop: true } });
  }
  // Over the unedited row as read here only: an edit saved meanwhile stays.
  // In bounded transactions: "develop all" can name a whole large gallery.
  const queued = [];
  for (let i = 0; i < changes.length; i += DEVELOP_CHUNK) {
    const part = changes.slice(i, i + DEVELOP_CHUNK);
    const revisions = await saveEdits(part, { onlyUnedited: true });
    queued.push(...part.map((change) => change.photo.id).filter((id) => revisions[id] !== undefined));
  }
  return queued;
}

/** After a RAW upload finished processing: its default develop, when the studio asked for that. */
async function afterUpload(photoId) {
  if (!(await autoDevelopEnabled())) return;
  if (!(await require('../middleware/requireFeatureFlag').isFeatureEnabled('photoEditor'))) return;
  const photo = await livePhotos(db).where({ id: photoId }).first();
  // A guest upload held for review is developed once approved
  // (uploadReviewService.moderatePhotos), not before: one that is rejected
  // never costs the render.
  if (photo && !photo.moderation_status) await queueDefaultDevelop([photo]);
}

// -------------------------------------------------------- background apply

/** Rows whose renditions are behind their edit. */
function pendingRows() {
  return wherePhotoProcessed(livePhotos(db))
    .join('events', 'photos.event_id', 'events.id')
    .whereRaw('photos.edit_rev > photos.edit_applied_rev')
    .where(function () {
      this.where('events.is_archived', false).orWhereNull('events.is_archived');
    });
}

/**
 * The responsive tiers of every revision but the row's current one: a
 * tier's key names the revision it was cut from (imageProcessor versionTag),
 * so the old ones would otherwise stay in storage for good. Dropped once
 * the row's revision is applied.
 */
function staleTierKeys(row) {
  const keys = new Set(historicalTierKeys(row, { upTo: Number(row.edit_rev) - 1 }));
  if (paramsOf(row)) {
    const imageProcessor = require('./imageProcessor');
    const original = { ...row, edit_params: null };
    for (const key of [...imageProcessor.thumbnailTierKeys(original), ...imageProcessor.previewTierKeys(original)]) keys.add(key);
  }
  return [...keys];
}

// Any edit stands in for the one a past revision had: tier keys name the
// revision, not the settings, so this is enough to list them after a reset
// cleared the params.
const PAST_EDIT = math.canonicalJson({ ...math.DEFAULT_PARAMS, develop: true });

/**
 * Tier keys revisions of the edit may have left: from the one whose
 * renditions were last in place up to `upTo` (at most 50 back).
 */
function historicalTierKeys(row, { upTo = Number(row.edit_rev) } = {}) {
  const imageProcessor = require('./imageProcessor');
  const keys = [];
  const from = Math.max(1, Number(row.edit_applied_rev) || 0, upTo - 50);
  for (let r = from; r <= upTo; r++) {
    const view = { ...row, edit_rev: r, edit_params: PAST_EDIT };
    keys.push(...imageProcessor.thumbnailTierKeys(view), ...imageProcessor.previewTierKeys(view));
  }
  return keys;
}

/** Drop a pre-generated watermark copy that shows another revision. */
async function dropWatermarkCopy(row) {
  if (!row.watermark_path || watermarkCopyCurrent(row, row.watermark_path) && paramsOf(row)) return;
  const cleared = await db('photos').where({ id: row.id, watermark_path: row.watermark_path })
    .update({ watermark_path: null, watermark_generated_at: null });
  if (cleared && !(await db('photos').where({ watermark_path: row.watermark_path }).first('id'))) {
    await require('./watermarkService').deleteWatermarkFile(row.watermark_path);
  }
}

/**
 * Bring one row's renditions to its edit revision. True when done (or
 * superseded), otherwise a short code for what failed (edit_error).
 * `references` is the pass's rendition owner index (renditionRefresh), read
 * once a pass rather than once a photo.
 */
async function applyPhoto(photo, references) {
  const rev = Number(photo.edit_rev);
  try {
    let row = await db('photos').where({ id: photo.id }).first();
    if (!row || Number(row.edit_rev) !== rev) return true;
    if (paramsOf(row)) {
      const rendered = await ensureEditedSource(row, { retryFailed: true }).catch((err) => {
        logger.warn(`Photo edit: photo ${photo.id} revision ${rev} could not be rendered: ${err.message}`);
        return null;
      });
      if (!rendered) return 'render';
    } else if (row.edit_render_path) {
      // A reset: the original is what guests get once it is applied. The
      // applied revision's render stays until then (renditions are cut from it).
      const cleared = await db('photos').where({ id: row.id, edit_rev: rev, edit_render_path: row.edit_render_path })
        .update({ edit_render_path: null, edit_width: null, edit_height: null });
      if (cleared && row.edit_render_path !== row.edit_applied_render_path && isRenderKeyOf(row, row.edit_render_path)) {
        await getStorage().delete(row.edit_render_path).catch(() => {});
      }
    }
    row = await db('photos').where({ id: photo.id }).first();
    if (!row || Number(row.edit_rev) !== rev) return true;
    // Listed now, dropped once applied: guests are served the applied
    // revision's tiers until then.
    const staleTiers = staleTierKeys(row);
    // Twice at most: a guest's request may record a rendition of the applied
    // revision over one just built here (it holds the row as it was); then
    // they are built again before the revision is applied.
    for (let attempt = 0; attempt < 2; attempt++) {
      // The renditions of the revision being applied, cut from its own
      // render (edit_view 'current': not the applied view guests' requests get).
      const written = {};
      if (!(await require('./renditionRefresh').refreshPhoto({ ...row, edit_view: 'current', edit_retry_failed: true }, references, written))) return 'renditions';
      await dropWatermarkCopy(row);
      const zip = require('./downloadZipService');
      await zip.invalidateIfBuilt(Number(row.event_id));
      // The applied edit, its size and render with it: what the previews now
      // show. One write, fenced on the revision applied before and on the
      // rendition keys built just now, so URL, pixels and boxes move together.
      const advanced = await db('photos')
        .where({ id: row.id, edit_rev: rev, edit_applied_rev: Number(row.edit_applied_rev) || 0, ...written })
        .update({
          edit_applied_rev: rev, edit_applied_params: row.edit_params || null,
          edit_applied_width: row.edit_params ? row.edit_width : null, edit_applied_height: row.edit_params ? row.edit_height : null,
          edit_applied_render_path: row.edit_params ? row.edit_render_path : null,
          edit_failed_rev: null, edit_error: null,
        });
      if (advanced) {
        const storage = getStorage();
        await Promise.all(staleTiers.map((key) => storage.delete(key).catch(() => {})));
        // The render of the revision applied before, no longer cut from.
        const previous = row.edit_applied_render_path;
        if (previous && previous !== row.edit_render_path && isRenderKeyOf(row, previous)) await storage.delete(previous).catch(() => {});
        return true;
      }
      row = await db('photos').where({ id: photo.id }).first();
      if (!row || Number(row.edit_rev) !== rev) return true;
    }
    return 'renditions';
  } catch (err) {
    logger.warn(`Photo edit: photo ${photo.id} revision ${rev} could not be applied: ${err.message}`);
    return 'error';
  }
}

let running = false;
let loop = null;
let waits = null;
let rerunRequested = false;

async function runPass({ active = () => running, sleep = (ms) => waits.sleep(ms) } = {}) {
  await maintenanceJobs.ensure(JOB_NAME);
  const token = await maintenanceJobs.claim(JOB_NAME);
  if (!token) return 'busy';
  const lease = maintenanceJobs.startLeaseKeeper(JOB_NAME, token);
  const counts = { applied: 0, failed: 0 };
  const limit = pLimit(concurrency());
  const references = require('./renditionRefresh').createReferenceIndex();
  try {
    let lastId = 0;
    while (active()) {
      if (lease.lost()) break;
      const batch = await pendingRows().where('photos.id', '>', lastId).orderBy('photos.id').limit(BATCH)
        .select('photos.id', 'photos.edit_rev', 'photos.event_id');
      if (!batch.length) break;
      lastId = batch[batch.length - 1].id;
      await Promise.all(batch.map((photo) => limit(async () => {
        if (!active() || lease.lost()) return;
        const outcome = await applyPhoto(photo, references);
        if (outcome === true) {
          counts.applied++;
        } else {
          counts.failed++;
          // On the row, not in memory: every replica reports it, and a retry
          // on any of them clears it. Tried again on later passes anyway.
          const recorded = await db('photos').where({ id: photo.id, edit_rev: Number(photo.edit_rev) })
            .update({ edit_failed_rev: Number(photo.edit_rev), edit_error: outcome })
            .catch((err) => logger.warn(`Photo edit: could not record the failure of photo ${photo.id}: ${err.message}`));
          // A failed crop or turn withholds the photo from guests: an archive
          // prepared with its old pictures goes as when the edit was saved
          // (download jobs check it per photo, downloadJobService).
          if (recorded) await require('./downloadZipService').invalidateIfBuilt(Number(photo.event_id)).catch(() => {});
        }
        const wait = loadGovernor.bulkDelayMs();
        if (wait) await sleep(wait);
      })));
    }
    await maintenanceJobs.release(JOB_NAME, token, counts).catch(() => {});
    if (counts.applied || counts.failed) logger.info(`Photo edits: ${counts.applied} applied, ${counts.failed} failed (retried later)`);
    return counts;
  } finally {
    lease.stop();
  }
}

async function runLoop() {
  await waits.sleep(intEnv('PHOTO_EDIT_DELAY_MS', 5000));
  while (running) {
    let outcome;
    rerunRequested = false;
    try {
      outcome = await runPass();
    } catch (err) {
      logger.error('Photo edit pass failed', { error: err.message });
    }
    if (!running) return;
    if (rerunRequested) continue;
    // Idle until a save asks again; failed rows are tried again meanwhile,
    // and a replica holding the claim is waited out.
    await waits.sleep(outcome === 'busy' ? RETRY_CLAIM_MS : RETRY_MS);
  }
}

function start() {
  if (loop) return;
  running = true;
  waits = createInterruptibleSleep();
  const current = runLoop()
    .catch((err) => logger.error('Photo edit loop crashed', { error: err.message }))
    .finally(() => {
      if (loop === current) {
        loop = null;
        running = false;
      }
    });
  loop = current;
}

function stop() {
  if (!loop) return Promise.resolve();
  running = false;
  waits.cancel();
  return loop;
}

/** Run a pass now: wake the idle loop (or start it). */
function requestPass() {
  if (!loop) {
    if (process.env.NODE_ENV === 'test') return;
    start();
    return;
  }
  rerunRequested = true;
  // Wake an idle loop: replace its sleeper (a cancelled one only wakes).
  const previous = waits;
  waits = createInterruptibleSleep();
  previous.cancel();
}

/**
 * Whether the pass failed to apply this photo's latest save (it is tried
 * again later). The admin listing reports it apart from a pending save, so
 * the editor can offer a retry and the grid stops polling for it.
 */
function hasFailed(photo) {
  return Number(photo.edit_rev) > Number(photo.edit_applied_rev) && Number(photo.edit_failed_rev) === Number(photo.edit_rev);
}

/**
 * Ask for failed photos of a gallery to be tried again now: they count as
 * pending until the pass has tried them. Returns how many were failed.
 */
async function retry(eventId, ids) {
  const cleared = await livePhotos(db).where({ event_id: eventId }).whereIn('id', ids)
    .whereRaw('edit_rev > edit_applied_rev').whereRaw('edit_failed_rev = edit_rev')
    .update({ edit_failed_rev: null, edit_error: null });
  if (cleared) requestPass();
  return cleared;
}

module.exports = {
  EDIT_COLUMNS,
  SOURCE_COLUMNS,
  sourceTag,
  DELIVERY_KEY,
  RENDER_KEY,
  withEditColumns,
  paramsOf,
  isEdited,
  isRenderKeyOf,
  renderEditedJpeg,
  originalPreviewJpeg,
  ensureEditedSource,
  deliveredPhoto,
  renditionView,
  withheldFromGuests,
  EDIT_FILE_COLUMNS,
  namedAsDelivered,
  deliveredKey,
  deliveredDimensions,
  editQuery,
  editVersionStale,
  watermarkCopyCurrent,
  focalAfterEdit,
  saveEdits,
  editCacheKeys,
  deleteEditedRender,
  AUTO_DEVELOP_SETTING,
  autoDevelopEnabled,
  queueDefaultDevelop,
  afterUpload,
  withOriginal,
  applyPhoto,
  runPass,
  start,
  stop,
  requestPass,
  hasFailed,
  retry,
};
