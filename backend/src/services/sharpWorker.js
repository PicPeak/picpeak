/* Native parser/transform worker. isolatedSharp launches this file as a warm
 * child and feeds it one JSON job per line; `run` is also its last-resort
 * in-process fallback. Nothing else may load it. */
const fs = require('fs');
const { estimate, refusal, MiB } = require('./imageResourcePolicy');

const RESPONSE_BYTES = MiB;
// EXIF/ICC/XMP/IPTC blocks travel back base64-encoded inside one response.
// Blocks beyond this budget are left out rather than failing the photo.
const METADATA_BLOCK_BYTES = 512 * 1024;

function errorCode(error) {
  if (error.code?.startsWith('IMAGE_')) return error.code;
  if (/pixel limit|out of memory|memory allocation|allocation failed|not enough memory|insufficient memory|cannot allocate|unable to allocate|malloc|bad_alloc/i.test(error.message || '')) return 'IMAGE_RESOURCE_LIMIT';
  // Ordinary missing/corrupt/unsupported sources keep existing null/original
  // fallback semantics. A crash/deadline/native cap refusal never does.
  return error.code || 'SHARP_PROCESSING_FAILED';
}
function serializeError(error) {
  return {
    message: String(error.message || error).slice(0, 1000), code: errorCode(error),
    ...(error.imageLimit ? { imageLimit: error.imageLimit, imageMax: error.imageMax } : {}),
  };
}
function serializable(value) {
  if (Buffer.isBuffer(value)) return { $bytes: value.toString('base64') };
  if (Array.isArray(value)) return value.map(serializable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, serializable(item)]));
  return value;
}
function serializableMetadata(metadata) {
  let budget = METADATA_BLOCK_BYTES;
  const result = {};
  for (const [key, value] of Object.entries(metadata)) {
    const size = Buffer.isBuffer(value) ? value.length
      : typeof value === 'string' ? Buffer.byteLength(value)
        : value && typeof value === 'object' ? Buffer.byteLength(JSON.stringify(serializable(value))) : 0;
    if (size > 4096) {
      if (size > budget) continue;
      budget -= size;
    }
    result[key] = serializable(value);
  }
  return result;
}
let native;
function loadSharp() {
  if (!native) {
    native = require('sharp');
    native.cache(false);
    native.concurrency(1);
  }
  return native;
}

async function run(job) {
  const sharp = loadSharp();
  const policy = job.policy;
  // Limits are accounted per file: one large file of a batch never spends
  // the allowance of the files after it.
  function check(filename) {
    const stat = fs.statSync(filename);
    if (!stat.isFile()) throw refusal('Image input is not a regular file');
    if (policy.inputBytes && stat.size > policy.inputBytes) {
      throw refusal(`Image file is ${Math.ceil(stat.size / MiB)} MiB; this server processes image files up to ${policy.inputBytes / MiB} MiB (IMAGE_MAX_INPUT_MIB)`,
        'IMAGE_RESOURCE_LIMIT', { imageLimit: 'input', imageMax: policy.inputBytes / MiB });
    }
    return stat;
  }
  const fingerprintOf = stat => ({ size: stat.size, dev: stat.dev, ino: stat.ino, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs });
  // Small secondary inputs (overlays, raw tiles) are read into memory; the
  // main input is always opened by path so libvips streams and shrinks it.
  function decode(value) {
    if (value && typeof value === 'object' && value.$buffer) { check(value.$buffer); return fs.readFileSync(value.$buffer); }
    if (Array.isArray(value)) return value.map(decode);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, decode(item)]));
    return value;
  }
  if (job.terminal === 'metadataBatch') {
    if (!Array.isArray(job.entries) || job.entries.length > 2000) throw refusal('Image admission batch is too large');
    const value = [];
    for (const input of job.entries) {
      try {
        const stat = check(input);
        // Header only, so sharp's own pixel limit is left to `estimate`, which
        // names the limit; every decode below still carries it.
        const metadata = await sharp(input, { limitInputPixels: false, failOn: 'none' }).metadata();
        const decodedBytes = estimate(metadata, policy);
        if (job.validate) {
          if (metadata.width < 10 || metadata.height < 10) throw new Error('Image dimensions too small');
          await sharp(input, { limitInputPixels: policy.maxPixels, failOn: 'none' }).resize(10, 10).toBuffer();
        }
        const fingerprint = fingerprintOf(stat);
        const after = fingerprintOf(fs.statSync(input));
        if (Object.keys(fingerprint).some(key => fingerprint[key] !== after[key])) throw new Error('Image input changed during reading');
        value.push({ input, decodedBytes, fingerprint });
      } catch (error) {
        value.push({ input, error: serializeError(error) });
      }
    }
    return { value };
  }
  const options = decode(job.options || {});
  const frames = metadata => (options.animated || options.pages === -1 || options.pages > 1 ? metadata.pages || 1 : 1);
  // No caller's legacy limit or parser mode may weaken policy.
  options.limitInputPixels = policy.maxPixels;
  let input = typeof job.input === 'string' ? job.input : job.input?.$buffer;
  if (typeof input !== 'string') throw refusal('Unsupported image input representation');
  check(input);
  // Raw pixel input has no container for libvips to open by path.
  if (options.raw) input = fs.readFileSync(input);
  let totalDecoded = 0;
  async function inspect(source, opts, count) {
    const metadata = await sharp(source, { ...opts, limitInputPixels: false }).metadata();
    totalDecoded += estimate(metadata, policy, count ? count(metadata) : 1);
    if (policy.decodedBytes && totalDecoded > policy.decodedBytes) {
      throw refusal(`Combined image inputs exceed ${policy.decodedBytes / MiB} MiB decoded (IMAGE_MAX_DECODED_MIB)`,
        'IMAGE_RESOURCE_LIMIT', { imageLimit: 'decoded', imageMax: policy.decodedBytes / MiB });
    }
    return metadata;
  }
  const metadata = await inspect(input, options, frames);
  if (job.terminal === 'metadata') return { value: serializableMetadata(metadata) };
  const pages = frames(metadata);
  const sourcePixels = metadata.width * (metadata.pageHeight || metadata.height);
  const outputLimit = (width, height, enlarges) => {
    const pixels = enlarges ? width * height : Math.min(width * height, sourcePixels);
    if (!Number.isSafeInteger(pixels) || width > policy.maxDimension || height > policy.maxDimension || pixels * pages > policy.maxPixels ||
        (policy.decodedBytes && pixels * 4 * pages > policy.decodedBytes)) {
      throw refusal(`Image output of ${width} x ${height} px exceeds what this server processes (IMAGE_MAX_PIXELS, IMAGE_MAX_DIMENSION)`,
        'IMAGE_RESOURCE_LIMIT', { imageLimit: 'pixels', imageMax: Math.round(policy.maxPixels / 1e5) / 10 });
    }
  };
  let pipeline = sharp(input, options);
  const allowed = new Set(['rotate', 'withMetadata', 'keepMetadata', 'resize', 'jpeg', 'png', 'webp', 'gif', 'extract', 'composite']);
  for (const [name, encodedArgs] of job.steps) {
    if (!allowed.has(name)) throw refusal('Unsupported image operation');
    const args = decode(encodedArgs);
    if (name === 'composite') {
      for (const overlay of args[0]) {
        if (typeof overlay.input === 'string') { check(overlay.input); overlay.input = fs.readFileSync(overlay.input); }
        if (!Buffer.isBuffer(overlay.input)) throw refusal('Unsupported composite input');
        await inspect(overlay.input, overlay.raw ? { raw: overlay.raw } : {});
      }
    }
    if (name === 'resize') {
      const dimensions = typeof args[0] === 'object' && args[0] !== null ? args[0] : { width: args[0], height: args[1], ...(args[2] || {}) };
      for (const value of [dimensions.width, dimensions.height]) {
        if (value != null && (!Number.isSafeInteger(value) || value <= 0 || value > policy.maxDimension)) {
          throw refusal(`Image output dimensions exceed ${policy.maxDimension} px per side (IMAGE_MAX_DIMENSION)`,
            'IMAGE_RESOURCE_LIMIT', { imageLimit: 'dimension', imageMax: policy.maxDimension });
        }
      }
      const enlarges = dimensions.withoutEnlargement !== true;
      if (dimensions.width && dimensions.height) outputLimit(dimensions.width, dimensions.height, enlarges);
      else if (dimensions.width || dimensions.height) {
        // A one-axis resize (PDF logos, for example) may imply an enormous
        // other dimension. Work it out, in the orientation the resize sees,
        // before allocation.
        const turned = job.steps.some(([step, stepArgs]) => step === 'rotate' &&
          (stepArgs.length ? Math.abs(stepArgs[0]) % 180 === 90 : metadata.orientation >= 5));
        const [across, down] = turned ? [metadata.pageHeight || metadata.height, metadata.width]
          : [metadata.width, metadata.pageHeight || metadata.height];
        if (dimensions.width) outputLimit(dimensions.width, Math.ceil(dimensions.width * down / across), enlarges);
        else outputLimit(Math.ceil(dimensions.height * across / down), dimensions.height, enlarges);
      }
    }
    pipeline = pipeline[name](...args);
  }
  if (job.terminal === 'toFile') {
    // The staged name keeps the target's extension: toFile infers the output
    // format from it when the caller set none.
    return { info: serializable(await pipeline.toFile(job.output)) };
  }
  const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });
  fs.writeFileSync(job.output, data, { flag: 'wx', mode: 0o600 });
  return { info: serializable(info) };
}

function serve() {
  const cap = Number(process.argv[2] || 0);
  if (cap > 0) {
    // Started under `ulimit -v`: refuse to parse anything if the address
    // space limit did not take. The parent then falls back, loudly.
    let limited = false;
    try {
      const match = fs.readFileSync('/proc/self/limits', 'utf8').match(/^Max address space\s+(\d+)\s+(\d+)\s+bytes\s*$/m);
      limited = Boolean(match) && Number(match[1]) <= cap && Number(match[2]) <= cap;
    } catch (_) { /* No procfs: not limited as far as we can tell. */ }
    if (!limited) process.exit(125);
  }
  try { loadSharp(); } catch (_) { process.exit(126); }
  process.stdout.write('{"ready":true}\n');
  let pending = '';
  let chain = Promise.resolve();
  const handle = async line => {
    let output;
    try {
      output = JSON.stringify(await run(JSON.parse(line)));
      if (Buffer.byteLength(output) > RESPONSE_BYTES) throw refusal('Image worker response exceeds the budget', 'IMAGE_WORKER_FAILED');
    } catch (error) {
      output = JSON.stringify({ error: serializeError(error) });
    }
    process.stdout.write(`${output}\n`);
  };
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    pending += chunk;
    let index;
    while ((index = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, index);
      pending = pending.slice(index + 1);
      chain = chain.then(() => handle(line));
    }
    if (pending.length > 2 * RESPONSE_BYTES) process.exit(1);
  });
  process.stdin.on('end', () => process.exit(0));
}
if (require.main === module) serve();
module.exports = { run, serializeError };
