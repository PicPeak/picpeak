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

/**
 * The source's EXIF without the images it can carry: the IFD1 thumbnail
 * (JPEG or strips) and the maker note, where cameras keep previews. A crop
 * must not ship the uncropped picture inside its own metadata. The bytes are
 * zeroed and IFD1 unlinked; the text tags stay. Null for a block that cannot
 * be read safely, which then goes out without EXIF.
 */
function exifWithoutImages(exif) {
  if (!exif || exif.toString('latin1', 0, 6) !== 'Exif\0\0') return null;
  const b = Buffer.from(exif);
  const base = 6;
  const little = b.toString('latin1', 6, 8) === 'II';
  const u16 = (o) => (little ? b.readUInt16LE(o) : b.readUInt16BE(o));
  const u32 = (o) => (little ? b.readUInt32LE(o) : b.readUInt32BE(o));
  const zero = (offset, length) => {
    const start = base + offset;
    if (start < base || length <= 0 || start + length > b.length) throw new Error('out of range');
    b.fill(0, start, start + length);
  };
  // The values of an IFD entry: inline when they fit in four bytes.
  const values = (entry) => {
    const type = u16(entry + 2);
    const count = u32(entry + 4);
    const size = type === 3 ? 2 : 4;
    const at = count * size <= 4 ? entry + 8 : base + u32(entry + 8);
    return Array.from({ length: count }, (_, i) => (type === 3 ? u16(at + i * 2) : u32(at + i * 4)));
  };
  try {
    const ifd0 = base + u32(base + 4);
    const count0 = u16(ifd0);
    for (let i = 0; i < count0; i++) {
      const entry = ifd0 + 2 + i * 12;
      if (u16(entry) !== 0x8769) continue;
      const exifIfd = base + u32(entry + 8);
      for (let j = 0; j < u16(exifIfd); j++) {
        const e = exifIfd + 2 + j * 12;
        if (u16(e) === 0x927c && u32(e + 4) > 4) zero(u32(e + 8), u32(e + 4));
      }
    }
    const next = ifd0 + 2 + count0 * 12;
    const ifd1 = u32(next);
    if (ifd1) {
      const at = base + ifd1;
      const tags = {};
      for (let i = 0; i < u16(at); i++) tags[u16(at + 2 + i * 12)] = at + 2 + i * 12;
      if (tags[0x0201] && tags[0x0202]) zero(values(tags[0x0201])[0], values(tags[0x0202])[0]);
      if (tags[0x0111] && tags[0x0117]) {
        const offsets = values(tags[0x0111]);
        const lengths = values(tags[0x0117]);
        offsets.forEach((offset, i) => zero(offset, lengths[i] || 0));
      }
      if (little) b.writeUInt32LE(0, next); else b.writeUInt32BE(0, next);
    }
    return b;
  } catch {
    return null;
  }
}

/** The source's XMP without its embedded thumbnails (xmp:Thumbnails, xmpGImg images). */
function xmpWithoutImages(xmp) {
  if (!xmp) return null;
  const text = xmp.toString('utf8')
    .replace(/<(xmp|xap):Thumbnails\b[\s\S]*?<\/\1:Thumbnails>/g, '')
    .replace(/<(xmpGImg|xapGImg):image\b[\s\S]*?<\/\1:image>/g, '')
    .replace(/\s(?:xmpGImg|xapGImg):image="[^"]*"/g, '');
  return Buffer.from(text, 'utf8');
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
 * bytes a pixel, 6 for a RAW develop) and the 3-byte output, plus three
 * 2-byte planes of the output while detail, shadows/highlights or
 * whites/blacks are in the edit. Metadata: the source's EXIF and XMP
 * (capture date, camera, copyright) go onto the result with the orientation
 * upright; for a RAW through exiftool from the container.
 */
async function renderEditedJpeg(photo, params, { interactive = false } = {}) {
  const sharp = require('./isolatedSharp');
  const rawDevelop = require('./rawDevelop');
  const imageProcessor = require('./imageProcessor');
  const limit = maxPixels();
  const encode = async (out) => sharp(out.data, { raw: { width: out.width, height: out.height, channels: 3 }, interactive })
    .jpeg({ quality: jpegQuality(), chromaSubsampling: '4:4:4' }).toBuffer();
  const decoded = async (sourcePath) => {
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
      buffer: imageProcessor.withSourceMetadata(await encode(out), { exif: exifWithoutImages(metadata.exif), xmp: xmpWithoutImages(metadata.xmp) }),
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
      const image = await rawDevelop.developLinear(localPath, { half, nr: params.nr });
      const out = await renderInWorker(image.data, image.width, image.height, 3, params,
        { maxPixels: limit, linear: true, exposureBias: info.exposureBias });
      // The container's tags, none of the RAW's preview images (a crop must
      // not carry the whole picture).
      return { buffer: await imageProcessor.withRawContainerTags(localPath, await encode(out), { withoutImages: true }), width: out.width, height: out.height };
    }
    const proc = await imageProcessor.withProcessableImage(localPath, sourceName);
    try {
      return await decoded(proc.path);
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
 */
async function renderAndRecord(photo, params, options) {
  const { buffer, width, height } = await renderEditedJpeg(photo, params, options);
  const key = `edits/edit_p${photo.id}_r${photo.edit_rev}_s${sourceTag(photo)}_${crypto.randomBytes(6).toString('hex')}.jpg`;
  const storage = getStorage();
  await storage.put(key, buffer);
  const current = await db('photos').where({ id: photo.id }).first(['edit_rev', 'edit_render_path']);
  const recorded = current && Number(current.edit_rev) === Number(photo.edit_rev)
    ? await db('photos').where({ id: photo.id, edit_rev: photo.edit_rev })
      .where((q) => (current.edit_render_path ? q.where('edit_render_path', current.edit_render_path) : q.whereNull('edit_render_path')))
      .update({ edit_render_path: key, edit_width: width, edit_height: height })
    : 0;
  if (recorded !== 1) {
    await storage.delete(key).catch(() => {});
    return null;
  }
  // The render this one replaced. Only a key of this photo's own render
  // namespace is deleted; a download still streaming it keeps its handle.
  if (current.edit_render_path && current.edit_render_path !== key && isRenderKeyOf(photo, current.edit_render_path)) {
    await storage.delete(current.edit_render_path).catch((err) => {
      logger.warn(`Could not remove the superseded edited render ${current.edit_render_path} of photo ${photo.id}: ${err.message}`);
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
async function ensureEditedSource(photo, { interactive = false } = {}) {
  photo = await withEditColumns(photo);
  let params = paramsOf(photo);
  if (!params) return null;
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
    const flightKey = `${photo.id}:${photo.edit_rev}`;
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
    photo = { ...photo, ...(await db('photos').where({ id: photo.id }).first(EDIT_COLUMNS)) };
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
async function deliveredPhoto(photo, options) {
  if (!photo || isVideoRow(photo)) return photo;
  const row = await withEditColumns(photo);
  if (!paramsOf(row)) return photo;
  const key = await ensureEditedSource(row, options);
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

/** Whether a stored watermark copy was made from the edit of the row's revision (watermarkService.watermarkKey). */
function watermarkCopyCurrent(photo, key) {
  return Boolean(key && String(key).includes(`_e${photo.edit_rev}_`));
}


/** `w`/`h` guests are shown: the edited size for an edited photo. */
function deliveredDimensions(photo) {
  if (paramsOf(photo) && photo.edit_width && photo.edit_height) {
    return { width: Number(photo.edit_width), height: Number(photo.edit_height) };
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
 */
async function saveEdits(changes) {
  const revisions = {};
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
      await trx('photos').where({ id: photo.id }).update(update);
      const row = await trx('photos').where({ id: photo.id }).first('edit_rev');
      revisions[photo.id] = Number(row.edit_rev);
    }
  });
  requestPass();
  return revisions;
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
  if (isRenderKeyOf(photo, photo.edit_render_path)) keys.push(photo.edit_render_path);
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
  if (changes.length) await saveEdits(changes);
  return changes.map((change) => change.photo.id);
}

/** After a RAW upload finished processing: its default develop, when the studio asked for that. */
async function afterUpload(photoId) {
  if (!(await autoDevelopEnabled())) return;
  if (!(await require('../middleware/requireFeatureFlag').isFeatureEnabled('photoEditor'))) return;
  const photo = await livePhotos(db).where({ id: photoId }).first();
  if (photo) await queueDefaultDevelop([photo]);
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
 * Delete the responsive tiers of every revision but the row's current one:
 * a tier's key names the revision it was cut from (imageProcessor
 * versionTag), so the old ones would otherwise stay in storage for good.
 */
async function dropStaleTiers(row) {
  const keys = new Set(historicalTierKeys(row, { upTo: Number(row.edit_rev) - 1 }));
  if (paramsOf(row)) {
    const imageProcessor = require('./imageProcessor');
    const original = { ...row, edit_params: null };
    for (const key of [...imageProcessor.thumbnailTierKeys(original), ...imageProcessor.previewTierKeys(original)]) keys.add(key);
  }
  const storage = getStorage();
  await Promise.all([...keys].map((key) => storage.delete(key).catch(() => {})));
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

/** Bring one row's renditions to its edit revision. True when done (or superseded). */
async function applyPhoto(photo) {
  const rev = Number(photo.edit_rev);
  try {
    let row = await db('photos').where({ id: photo.id }).first();
    if (!row || Number(row.edit_rev) !== rev) return true;
    if (paramsOf(row)) {
      if (!(await ensureEditedSource(row))) return false;
    } else if (row.edit_render_path) {
      // A reset: the original is what guests get again.
      const cleared = await db('photos').where({ id: row.id, edit_rev: rev, edit_render_path: row.edit_render_path })
        .update({ edit_render_path: null, edit_width: null, edit_height: null });
      if (cleared) await deleteEditedRender(row);
    }
    row = await db('photos').where({ id: photo.id }).first();
    if (!row || Number(row.edit_rev) !== rev) return true;
    await dropStaleTiers(row);
    if (!(await require('./renditionRefresh').refreshPhoto(row))) return false;
    await dropWatermarkCopy(row);
    const zip = require('./downloadZipService');
    await zip.invalidateIfBuilt(Number(row.event_id));
    await db('photos').where({ id: row.id, edit_rev: rev }).update({ edit_applied_rev: rev });
    return true;
  } catch (err) {
    logger.warn(`Photo edit: photo ${photo.id} revision ${rev} could not be applied: ${err.message}`);
    return false;
  }
}

let running = false;
let loop = null;
let waits = null;
let rerunRequested = false;
// Rows that failed at a revision, so status can say so; retried on the next pass.
const failures = new Map();

async function runPass({ active = () => running, sleep = (ms) => waits.sleep(ms) } = {}) {
  await maintenanceJobs.ensure(JOB_NAME);
  const token = await maintenanceJobs.claim(JOB_NAME);
  if (!token) return 'busy';
  const lease = maintenanceJobs.startLeaseKeeper(JOB_NAME, token);
  const counts = { applied: 0, failed: 0 };
  const limit = pLimit(concurrency());
  try {
    let lastId = 0;
    while (active()) {
      if (lease.lost()) break;
      const batch = await pendingRows().where('photos.id', '>', lastId).orderBy('photos.id').limit(BATCH)
        .select('photos.id', 'photos.edit_rev');
      if (!batch.length) break;
      lastId = batch[batch.length - 1].id;
      await Promise.all(batch.map((photo) => limit(async () => {
        if (!active() || lease.lost()) return;
        if (await applyPhoto(photo)) {
          counts.applied++;
          failures.delete(photo.id);
        } else {
          counts.failed++;
          failures.set(photo.id, Number(photo.edit_rev));
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
 * Progress of a gallery's edits for the admin: every photo still to apply,
 * or, with `ids`, those of them (a batch larger than one answer's id list).
 */
async function status(eventId, ids = null) {
  let query = livePhotos(db).where({ event_id: eventId }).whereRaw('edit_rev > edit_applied_rev');
  if (ids) query = query.whereIn('id', ids);
  const rows = await query.select('id', 'edit_rev');
  const failed = rows.filter((row) => failures.get(row.id) === Number(row.edit_rev)).map((row) => row.id);
  return { pending: rows.length, failed: failed.length, pending_ids: rows.slice(0, 500).map((row) => row.id), failed_ids: failed.slice(0, 500) };
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
  status,
};
