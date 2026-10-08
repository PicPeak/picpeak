const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { AsyncLocalStorage } = require('async_hooks');
const runner = require('./nativeProcessRunner');
const attemptContext = require('./mediaAttemptContext');
const { configuration, estimate, refusal } = require('./mediaProcessPolicy');

const context = new AsyncLocalStorage();
let snapshotBytes = 0;
let accepting = true;
const activeSnapshots = new Set();
function videoSignature(bytes) {
  if (bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return 'matroska,webm';
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'AVI ') return 'avi';
  if (bytes.length >= 12 && ['ftyp', 'moov', 'mdat', 'wide', 'free', 'skip'].includes(bytes.toString('ascii', 4, 8)) && (bytes.readUInt32BE(0) === 1 || bytes.readUInt32BE(0) >= 8)) return 'mov,mp4,m4a,3gp,3g2,mj2';
  if (bytes.subarray(0, 3).equals(Buffer.from([0, 0, 1]))) return 'mpeg,mpegvideo';
  if (bytes[0] === 0x47 && bytes.length >= 377 && bytes[188] === 0x47 && bytes[376] === 0x47) return 'mpegts';
  if (bytes.toString('ascii', 0, 4) === 'OggS') return 'ogg';
  throw refusal('Video container signature is invalid', 'MEDIA_INVALID_SIGNATURE');
}
function rawSignature(bytes, name) {
  const ext = path.extname(name).toLowerCase();
  const header = bytes.toString('ascii', 0, 4);
  const tiff = ['II*\0', 'MM\0*', 'II+\0', 'MM\0+'].includes(header);
  const valid = ext === '.raf' ? bytes.toString('ascii', 0, 15) === 'FUJIFILMCCD-RAW' :
    ext === '.rw2' ? header === 'IIU\0' || tiff :
      ext === '.orf' ? ['IIRO', 'IIRS', 'MMOR'].includes(header) || tiff :
        ext === '.cr3' ? bytes.toString('ascii', 4, 8) === 'ftyp' && bytes.toString('ascii', 8, 12) === 'crx ' : tiff;
  if (!valid) throw refusal('RAW container signature is invalid', 'MEDIA_INVALID_SIGNATURE');
}
// Each command brings its own time budget, counted from the moment it
// starts: waiting behind other jobs costs none of it.
function run(command, args, options = {}) {
  const scope = context.getStore();
  return runner.run(command, args, { ...options, signal: options.signal || scope?.signal });
}
async function withSnapshot(source, kind, callback, { sourceName = source, signal } = {}) {
  if (!accepting) throw refusal('Media processing is stopped', 'MEDIA_CANCELLED');
  const policy = configuration();
  const inherited = context.getStore();
  const attempt = attemptContext.current();
  const controller = new AbortController();
  const signals = [signal, inherited?.signal, attempt?.signal, controller.signal].filter(Boolean);
  const scope = { signal: AbortSignal.any(signals) };
  let finished;
  const operation = { controller, done: new Promise(resolve => { finished = resolve; }) };
  activeSnapshots.add(operation);
  let dir, input, output, charge = 0;
  try {
    await attempt?.assertCurrent();
    input = await fsp.open(source, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    const before = await input.stat();
    if (!before.isFile() || before.size <= 0) throw refusal('Media input is empty or not a file', 'MEDIA_INVALID_SIGNATURE');
    if (policy.inputBytes && before.size > policy.inputBytes) throw refusal(`Media input is ${Math.ceil(before.size / 1048576)} MiB; this server processes media up to ${policy.inputBytes / 1048576} MiB (MEDIA_MAX_INPUT_MIB)`);
    // The private copy guards against a file that changes under the parser.
    // A file too large to stage is read where it is rather than refused,
    // and one that only has to wait for staging room is put back in line.
    if (before.size > policy.snapshotBytes) {
      const header = Buffer.alloc(Math.min(512, before.size));
      await input.read(header, 0, header.length, 0);
      const format = kind === 'raw' ? (rawSignature(header, sourceName), null) : videoSignature(header);
      return await context.run(scope, () => callback(source, { policy, format }));
    }
    if (snapshotBytes + before.size > policy.snapshotBytes) throw refusal('Media input staging capacity is full', 'MEDIA_QUEUE_FULL', { retryAfter: 5 });
    snapshotBytes += before.size; charge = before.size;
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'picpeak-media-'));
    const localPath = path.join(dir, `input${path.extname(sourceName).toLowerCase()}`);
    output = await fsp.open(localPath, 'wx', 0o600);
    let copied = 0;
    const reader = fs.createReadStream(source, { fd: input.fd, autoClose: false });
    for await (const chunk of reader) {
      if (scope.signal?.aborted) throw refusal('Media processing was cancelled', 'MEDIA_CANCELLED');
      copied += chunk.length;
      if (copied > before.size) throw refusal('Media input changed during admission');
      await output.writeFile(chunk);
    }
    const after = await input.stat();
    if (copied !== before.size || ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].some(field => before[field] !== after[field])) throw refusal('Media input changed during admission');
    await output.close(); output = null;
    const header = Buffer.alloc(Math.min(512, copied));
    const file = await fsp.open(localPath, 'r');
    try { await file.read(header, 0, header.length, 0); } finally { await file.close(); }
    const format = kind === 'raw' ? (rawSignature(header, sourceName), null) : videoSignature(header);
    return await context.run(scope, () => callback(localPath, { policy, format }));
  } finally {
    try {
      await output?.close().catch(() => {}); await input?.close().catch(() => {});
      if (dir) await fsp.rm(dir, { recursive: true, force: true });
    } finally {
      snapshotBytes -= charge;
      activeSnapshots.delete(operation); finished();
    }
  }
}
function inputOptions(format, threads = 1) { return ['-protocol_whitelist', 'file,pipe', '-format_whitelist', format, '-threads', String(threads)]; }
async function probeSnapshot(localPath, { policy = configuration(), format } = {}) {
  const result = await run('ffprobe', ['-v', 'error', ...inputOptions(format), '-probesize', '10485760', '-analyzeduration', '10000000', '-show_format', '-show_streams', '-of', 'json', localPath],
    { memoryBytes: policy.nativeBytes, wallMs: policy.probeMs, cpuSeconds: Math.ceil(policy.probeMs / 1000), outputBytes: 1024 * 1024 });
  let metadata;
  try { metadata = JSON.parse(result.stdout.toString()); } catch (_) { throw refusal('Invalid video probe response', 'MEDIA_WORKER_FAILED'); }
  estimate(metadata, policy);
  return metadata;
}
async function probeVideo(localPath, { signal } = {}) { return withSnapshot(localPath, 'probe', (snapshot, details) => probeSnapshot(snapshot, details), { signal }); }
module.exports = { run, withSnapshot, probeSnapshot, probeVideo, inputOptions, videoSignature, rawSignature,
  currentScope: () => context.getStore(),
  start: () => { accepting = true; runner.start(); },
  stop: async () => {
    accepting = false;
    const pending = [...activeSnapshots]; for (const operation of pending) operation.controller.abort();
    await Promise.all(pending.map(operation => operation.done));
  } };
