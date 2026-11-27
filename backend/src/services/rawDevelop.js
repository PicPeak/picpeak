/**
 * Camera RAW development for the photo editor (issue 2619).
 *
 * The demosaic is LibRaw's `dcraw_emu`, run as a separate program (Alpine's
 * libraw-tools, Debian/Ubuntu's libraw-bin) through the guarded media
 * process runner, like ffmpeg and exiftool: an argument list and never a
 * shell, a time and memory budget, output to a file. LibRaw is LGPL/CDDL and
 * is only ever used as that binary; nothing of it is linked or bundled.
 *
 * Every develop asks for the same thing: 16-bit linear RGB in linear sRGB
 * primaries with the camera's as-shot white balance applied (`-4 -o 1 -w`),
 * highlights rebuilt from the unclipped channels (`-H`), no auto brightening.
 * That is the scene-referred input of the edit pipeline (photoEditMath with
 * `linear: true`): the editor's preview gets a half-size develop of it
 * (cached, see developPreview), the saved photo a full-quality one.
 *
 * Until a RAW photo is developed (it has an edit, or was developed with the
 * default look) it keeps today's behaviour: its embedded JPEG preview.
 *
 * Tunables (env, all optional):
 *   DCRAW_EMU_PATH            the dcraw_emu binary (default: dcraw_emu on PATH)
 *   RAW_DEVELOP_TIMEOUT_MS    default 180000 per develop
 *   PREVIEW_REGEN_CONCURRENCY develops at once (default 1), shared with the
 *                             preview regeneration
 */

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const pLimit = require('p-limit');
const logger = require('../utils/logger');
const { isRawFilename } = require('../utils/rawFormats');

const MiB = 1024 * 1024;
// Highlight reconstruction: rebuild clipped highlights from the channels that
// still hold detail (LibRaw's "rebuild" modes are 3-9; 5 is a moderate one).
const HIGHLIGHT_MODE = '5';
// The editor's develop preview: at most this long, at half the sensor size.
const PREVIEW_LONG_EDGE = 2048;
const PREVIEW_FORMAT = 1;

const intEnv = (name, fallback) => {
  const value = parseInt(process.env[name] || '', 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};
const binary = () => process.env.DCRAW_EMU_PATH || 'dcraw_emu';
const identifyBinary = () => process.env.RAW_IDENTIFY_PATH || 'raw-identify';
const limit = pLimit(Math.min(8, intEnv('PREVIEW_REGEN_CONCURRENCY', 1)));

let availability = null;
/** Whether dcraw_emu can be run here; asked once per process. */
function isAvailable() {
  if (!availability) {
    availability = new Promise((resolve) => {
      const child = require('child_process').spawn(binary(), [], { stdio: 'ignore' });
      child.once('error', () => resolve(false));
      // It prints its usage and exits non-zero without a file: it is there.
      child.once('exit', () => resolve(true));
    }).then((ok) => {
      if (!ok) logger.info('RAW development: dcraw_emu (LibRaw) is not installed; RAW photos keep their embedded preview');
      return ok;
    });
  }
  return availability;
}

/**
 * The noise reduction slider (0..100) as LibRaw options: FBDD before the
 * demosaic (light up to 50, full above) and up to three median passes over
 * the colour differences, which is chroma noise. Only the full develop takes
 * them: FBDD needs the full demosaic, and the editor's preview approximates
 * by leaving noise reduction out (it says so). LibRaw's wavelet denoise
 * (`-n`) is not used: LibRaw 0.22 crashes on it for some DNGs.
 */
function noiseOptions(nr) {
  const amount = Math.max(0, Math.min(100, Math.round(Number(nr) || 0)));
  if (!amount) return [];
  return ['-fbdd', amount > 50 ? '2' : '1', '-m', String(Math.max(1, Math.round(amount / 34)))];
}

/** dcraw_emu's arguments for a develop of `file`. */
function developArgs(file, { half = false, nr = 0 } = {}) {
  return [
    '-4', '-o', '1', '-w', '-H', HIGHLIGHT_MODE,
    ...(half ? ['-h'] : ['-q', '3', ...noiseOptions(nr)]),
    '-Z', '-',
    // Absolute, so a name can never read as an option.
    path.resolve(file),
  ];
}

/**
 * Parse a binary PPM (P6) from dcraw_emu: 16-bit big-endian samples, turned
 * little-endian in place so the returned Uint16Array is a view, not a copy.
 */
function parsePpm(buffer) {
  const head = buffer.toString('latin1', 0, Math.min(buffer.length, 64));
  const match = /^P6\s+(\d+)\s+(\d+)\s+(\d+)\s/.exec(head);
  if (!match) throw new Error('dcraw_emu did not write a PPM image');
  const width = Number(match[1]);
  const height = Number(match[2]);
  const maxval = Number(match[3]);
  const offset = match[0].length;
  const bytes = width * height * 3 * (maxval > 255 ? 2 : 1);
  if (maxval !== 65535 || buffer.length < offset + bytes) throw new Error('dcraw_emu wrote an incomplete 16-bit image');
  const body = buffer.subarray(offset, offset + bytes);
  body.swap16();
  const aligned = body.byteOffset % 2 === 0 ? body : Buffer.from(body);
  return { width, height, data: new Uint16Array(aligned.buffer, aligned.byteOffset, width * height * 3) };
}

/**
 * Develop the RAW at `file` to 16-bit linear RGB: `{ width, height, data }`
 * (interleaved Uint16, 0..65535). `half`: half the sensor size, the fast
 * demosaic; otherwise AHD at full size. The image is read from a temp file
 * dcraw_emu writes, so its size is bounded by the file budget, not by the
 * runner's pipe.
 */
async function developLinear(file, { half = false, nr = 0, signal } = {}) {
  return limit(async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'picpeak-raw-'));
    const out = path.join(dir, 'develop.ppm');
    try {
      const policy = require('./mediaProcessPolicy').configuration();
      await require('./mediaProcessService').run(binary(), developArgs(file, { half, nr }), {
        lane: 'long',
        stdoutPath: out,
        memoryBytes: policy.nativeBytes,
        cpuSeconds: 600,
        wallMs: intEnv('RAW_DEVELOP_TIMEOUT_MS', 180000),
        outputBytes: MiB,
        // 16-bit RGB of a 100 MP sensor, with room.
        fileBytes: 1024 * MiB,
        signal,
      });
      return parsePpm(await fsp.readFile(out));
    } finally {
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });
}

/**
 * What LibRaw reads from the RAW: the developed size and the as-shot white
 * balance multipliers. The highlight rebuild makes dcraw_emu scale by the
 * largest multiplier instead of the smallest, which leaves the picture
 * log2(max / min) EV darker than a plain develop; `exposureBias` gives that
 * back, so the baseline lands where it would without highlight recovery.
 */
async function identify(file) {
  const result = await require('./mediaProcessService').run(identifyBinary(), ['-v', path.resolve(file)], {
    memoryBytes: require('./mediaProcessPolicy').configuration().nativeBytes,
    cpuSeconds: 30, wallMs: 60000, outputBytes: 4 * MiB,
  });
  const text = result.stdout.toString('utf8');
  const size = /Output size:\s*(\d+)\s*x\s*(\d+)/.exec(text) || /Image size:\s*(\d+)\s*x\s*(\d+)/.exec(text);
  const shot = /As shot\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/.exec(text);
  const multipliers = shot ? shot.slice(1, 5).map(Number) : null;
  const used = multipliers ? multipliers.filter((v) => v > 0) : [];
  const exposureBias = used.length >= 2 ? Math.log2(Math.max(...used) / Math.min(...used)) : 0;
  return {
    width: size ? Number(size[1]) : null,
    height: size ? Number(size[2]) : null,
    multipliers,
    exposureBias: Number.isFinite(exposureBias) ? Math.min(4, exposureBias) : 0,
  };
}

/** Average `factor` x `factor` blocks: the develop preview from a half-size develop. */
function shrink(image, longEdge) {
  const factor = Math.max(1, Math.ceil(Math.max(image.width, image.height) / longEdge));
  if (factor === 1) return image;
  const width = Math.floor(image.width / factor);
  const height = Math.floor(image.height / factor);
  const data = new Uint16Array(width * height * 3);
  const area = factor * factor;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      for (let c = 0; c < 3; c++) {
        let sum = 0;
        for (let dy = 0; dy < factor; dy++) {
          const row = ((y * factor + dy) * image.width + x * factor) * 3 + c;
          for (let dx = 0; dx < factor; dx++) sum += image.data[row + dx * 3];
        }
        data[(y * width + x) * 3 + c] = Math.round(sum / area);
      }
    }
  }
  return { width, height, data };
}

/** The develop preview file: "PPDV", a header length, a JSON header, then Uint16 LE RGB. */
function encodePreview(image, header) {
  const json = Buffer.from(JSON.stringify({ format: PREVIEW_FORMAT, width: image.width, height: image.height, channels: 3, bits: 16, ...header }), 'utf8');
  const prefix = Buffer.alloc(8);
  prefix.write('PPDV', 0, 'latin1');
  prefix.writeUInt32LE(json.length, 4);
  const pixels = Buffer.from(image.data.buffer, image.data.byteOffset, image.data.byteLength);
  if (os.endianness() !== 'LE') pixels.swap16();
  return Buffer.concat([prefix, json, pixels]);
}

function decodePreview(buffer) {
  if (buffer.toString('latin1', 0, 4) !== 'PPDV') throw new Error('Not a develop preview');
  const length = buffer.readUInt32LE(4);
  const header = JSON.parse(buffer.toString('utf8', 8, 8 + length));
  const start = 8 + length;
  const pixels = Buffer.from(buffer.subarray(start, start + header.width * header.height * 6));
  return { header, width: header.width, height: header.height, data: new Uint16Array(pixels.buffer, pixels.byteOffset, header.width * header.height * 3) };
}

/** Whether a photo row is named like a camera RAW; isRawSource then asks the bytes. */
const isRawPhoto = (photo) => Boolean(photo) && isRawFilename(photo.original_filename || photo.filename || photo.path || '');

/**
 * Whether a file's first bytes rule a RAW out: they are an ordinary image
 * (JPEG, PNG, WebP, GIF). A JPEG renamed .CR3 must never reach LibRaw.
 * TIFF-like headers are not ruled out: most RAW containers are TIFF.
 */
async function isOrdinaryImageFile(filePath) {
  const { sniffImageFileType } = require('../utils/fileSecurityUtils');
  return Boolean(await sniffImageFileType(filePath));
}

/** A RAW by name whose stored bytes are not an ordinary image. */
async function isRawSource(photo) {
  if (!isRawPhoto(photo)) return false;
  const { sniffImageType } = require('../utils/fileSecurityUtils');
  const { resolvePhotoStorageKey, resolvePhotoFilePath } = require('./photoResolver');
  const { db } = require('../database/db');
  try {
    const event = await db('events').where({ id: photo.event_id }).first();
    const key = resolvePhotoStorageKey(event, photo);
    if (key) {
      const chunks = [];
      for await (const chunk of await require('./storage').getStorage().getRange(key, 0, 63)) chunks.push(chunk);
      return !sniffImageType(Buffer.concat(chunks));
    }
    return !(await isOrdinaryImageFile(resolvePhotoFilePath(event, photo)));
  } catch {
    return false;
  }
}

/**
 * The storage key of a photo's develop preview. Named after what identifies
 * the original's bytes (as imageProcessor's derivative names are), so a
 * replaced or rewritten original gets a new preview and the old one is not
 * found.
 */
function previewKey(photo) {
  const identity = JSON.stringify([photo.id, photo.path, photo.external_relpath, photo.size_bytes ?? null,
    photo.source_mtime_ms ?? null, photo.processing_attempt_id ?? null, PREVIEW_FORMAT]);
  return `edits/develop_p${photo.id}_${crypto.createHash('sha256').update(identity).digest('hex').slice(0, 12)}.bin`;
}

const previewFlights = new Map();

/**
 * The develop preview of a RAW photo for the editor: a cached, encoded
 * buffer (see encodePreview), developed now when there is none.
 * `withOriginal(photo, fn)` opens the original (photoEdits).
 */
async function developPreview(photo, withOriginal) {
  const storage = require('./storage').getStorage();
  const key = previewKey(photo);
  try {
    if (await storage.stat(key)) return await streamToBuffer(await storage.get(key));
  } catch (err) {
    if (require('./storage/storageErrors').isStorageUnavailableError(err)) throw err;
  }
  let flight = previewFlights.get(key);
  if (!flight) {
    flight = (async () => {
      const started = Date.now();
      const { image, info } = await withOriginal(photo, async (file) => ({
        info: await identify(file),
        image: await developLinear(file, { half: true }),
      }), { raw: true });
      const encoded = encodePreview(shrink(image, PREVIEW_LONG_EDGE), {
        linear: true, primaries: 'srgb', whiteBalance: 'as-shot', highlights: `rebuild-${HIGHLIGHT_MODE}`,
        exposureBias: info.exposureBias, cameraMultipliers: info.multipliers,
      });
      await storage.put(key, encoded);
      logger.info(`RAW develop preview of photo ${photo.id}: ${Date.now() - started} ms`);
      return encoded;
    })().finally(() => previewFlights.delete(key));
    previewFlights.set(key, flight);
  }
  return flight;
}

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

module.exports = {
  HIGHLIGHT_MODE,
  PREVIEW_LONG_EDGE,
  isAvailable,
  isRawPhoto,
  isRawSource,
  isOrdinaryImageFile,
  identify,
  developArgs,
  noiseOptions,
  parsePpm,
  developLinear,
  shrink,
  encodePreview,
  decodePreview,
  previewKey,
  developPreview,
};
