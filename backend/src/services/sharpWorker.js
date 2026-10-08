/* One-shot native parser/transform. Only isolatedSharp may launch this file. */
const fs = require('fs');
const { estimate, refusal } = require('./imageResourcePolicy');
function errorCode(error) {
  if (error.code?.startsWith('IMAGE_')) return error.code;
  if (/pixel limit|out of memory|memory allocation|allocation failed|not enough memory|insufficient memory|cannot allocate|unable to allocate|malloc|bad_alloc/i.test(error.message || '')) return 'IMAGE_RESOURCE_LIMIT';
  // Ordinary missing/corrupt/unsupported sources keep existing null/original
  // fallback semantics. A crash/deadline/native cap refusal never does.
  return error.code || 'SHARP_PROCESSING_FAILED';
}

async function main(job) {
  const match = fs.readFileSync('/proc/self/limits', 'utf8').match(/^Max address space\s+(\d+)\s+(\d+)\s+bytes\s*$/m);
  if (!match || Number(match[1]) > job.policy.nativeBytes || Number(match[2]) > job.policy.nativeBytes) {
    throw refusal('Native image memory limit is unavailable', 'IMAGE_WORKER_UNAVAILABLE');
  }
  const sharp = require('sharp');
  sharp.cache(false);
  sharp.concurrency(1);
  let inputBytes = 0;
  let totalDecoded = 0;
  let fingerprint;
  function bytes(filename) {
    const fd = fs.openSync(filename, 'r');
    try {
      const stat = fs.fstatSync(fd);
      inputBytes += stat.size;
      if (!stat.isFile() || inputBytes > job.policy.inputBytes) throw refusal('Image inputs exceed the processing byte budget');
      // A single immutable Buffer is used for the probe and the transform.
      const buffer = Buffer.alloc(stat.size);
      let offset = 0;
      while (offset < buffer.length) {
        const read = fs.readSync(fd, buffer, offset, buffer.length - offset, offset);
        if (!read) throw refusal('Image input changed during reading');
        offset += read;
      }
      if (fs.fstatSync(fd).size !== stat.size) throw refusal('Image input changed during reading');
      fingerprint = { size: stat.size, dev: stat.dev, ino: stat.ino, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs };
      return buffer;
    } finally { fs.closeSync(fd); }
  }
  function decode(value) {
    if (value && typeof value === 'object' && value.$buffer) return bytes(value.$buffer);
    if (Array.isArray(value)) return value.map(decode);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, decode(item)]));
    return value;
  }
  const options = decode(job.options || {});
  if (job.terminal === 'metadataBatch') {
    if (!Array.isArray(job.entries) || job.entries.length > 2000) throw refusal('Image admission batch is too large');
    const value = [];
    let batchBytes = 0;
    for (const input of job.entries) {
      try {
        const buffer = bytes(input);
        const metadata = await sharp(buffer, { limitInputPixels: job.policy.maxPixels, failOn: 'none' }).metadata();
        const decodedBytes = estimate(metadata, job.policy);
        if (batchBytes + decodedBytes > job.policy.batchBytes) throw refusal('Image batch exceeds the decoded processing budget');
        batchBytes += decodedBytes;
        if (job.validate) {
          if (metadata.width < 10 || metadata.height < 10) throw refusal('Image dimensions too small');
          await sharp(buffer, { limitInputPixels: job.policy.maxPixels, failOn: 'none' }).resize(10, 10).toBuffer();
        }
        value.push({ input, decodedBytes, fingerprint });
      } catch (error) {
        value.push({ input, error: { message: error.code?.startsWith('IMAGE_') ? error.message : 'Image could not be admitted within its resource budget',
          code: errorCode(error) } });
      }
    }
    return { value };
  }
  // No caller's legacy limit, all-pages flag or parser mode may weaken policy.
  options.limitInputPixels = job.policy.maxPixels;
  const input = typeof job.input === 'string' ? bytes(job.input) : decode(job.input);
  if (!Buffer.isBuffer(input)) throw refusal('Unsupported image input representation');
  async function inspect(buffer, opts) {
    const metadata = await sharp(buffer, { ...opts, limitInputPixels: job.policy.maxPixels }).metadata();
    totalDecoded += estimate(metadata, job.policy);
    if (totalDecoded > job.policy.decodedBytes) throw refusal('Combined image inputs exceed the decoded budget');
    return metadata;
  }
  const metadata = await inspect(input, options);
  if (job.terminal === 'metadata') return { value: serializable(metadata) };
  let pipeline = sharp(input, options);
  const allowed = new Set(['rotate', 'withMetadata', 'keepMetadata', 'resize', 'jpeg', 'png', 'webp', 'gif', 'extract', 'composite']);
  for (const [name, encodedArgs] of job.steps) {
    if (!allowed.has(name)) throw refusal('Unsupported image operation');
    const args = decode(encodedArgs);
    if (name === 'composite') {
      for (const overlay of args[0]) {
        if (typeof overlay.input === 'string') overlay.input = bytes(overlay.input);
        if (!Buffer.isBuffer(overlay.input)) throw refusal('Unsupported composite input');
        await inspect(overlay.input, overlay.raw ? { raw: overlay.raw } : {});
      }
    }
    if (name === 'resize') {
      const dimensions = typeof args[0] === 'object' ? args[0] : { width: args[0], height: args[1] };
      for (const value of [dimensions?.width, dimensions?.height]) {
        if (value != null && (!Number.isSafeInteger(value) || value <= 0 || value > job.policy.maxDimension)) throw refusal('Image output dimensions exceed the processing budget');
      }
      if (dimensions?.width && dimensions?.height && dimensions.width * dimensions.height * 4 * (metadata.pages || 1) > job.policy.decodedBytes) {
        throw refusal('Image output decoded size exceeds the processing budget');
      }
      if (Boolean(dimensions?.width) !== Boolean(dimensions?.height)) {
        // A one-axis resize (PDF logos, for example) may imply an enormous
        // other dimension. Account for either orientation before allocation.
        const aspect = Math.max(metadata.width / (metadata.pageHeight || metadata.height),
          (metadata.pageHeight || metadata.height) / metadata.width);
        const edge = dimensions.width || dimensions.height;
        const other = Math.ceil(edge * aspect);
        if (!Number.isSafeInteger(other) || other > job.policy.maxDimension ||
            edge * other * 4 * (metadata.pages || 1) > job.policy.decodedBytes) {
          throw refusal('Image output decoded size exceeds the processing budget');
        }
      }
    }
    pipeline = pipeline[name](...args);
  }
  const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });
  if (data.length > job.policy.outputBytes) throw refusal('Image output exceeds the byte budget');
  fs.writeFileSync(job.output, data, { flag: 'wx', mode: 0o600 });
  return { info: serializable(info) };
}
function serializable(value) {
  if (Buffer.isBuffer(value)) return { $bytes: value.toString('base64') };
  if (Array.isArray(value)) return value.map(serializable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, serializable(item)]));
  return value;
}
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  input += chunk;
  if (Buffer.byteLength(input) > 1024 * 1024) process.exit(1);
});
process.stdin.on('end', async () => {
  try {
    const result = await main(JSON.parse(input));
    const output = JSON.stringify(result);
    if (Buffer.byteLength(output) > 1024 * 1024) throw refusal('Image metadata exceeds the byte budget');
    process.stdout.write(output);
  } catch (error) {
    process.stdout.write(JSON.stringify({ error: { message: error.code?.startsWith('IMAGE_') ? error.message : 'Image could not be processed', code: errorCode(error) } }));
  }
});
