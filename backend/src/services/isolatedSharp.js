/** Sharp-compatible subset used by PicPeak. Native code is never loaded here. */
const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { configuration, refusal } = require('./imageResourcePolicy');

const methods = ['rotate', 'withMetadata', 'keepMetadata', 'resize', 'jpeg', 'png', 'webp', 'gif', 'extract', 'composite'];
let active = 0;
let retainedBytes = 0;
const queue = [];
function pump() {
  while (queue.length && active < queue[0].policy.workers) {
    const entry = queue.shift();
    if (entry.done) continue;
    active++;
    entry.running = true;
    execute(entry).then(entry.resolve, entry.reject).finally(() => { active--; pump(); });
  }
}
async function encode(value, dir, policy, state) {
  if (Buffer.isBuffer(value)) {
    state.bytes += value.length;
    if (state.bytes > policy.inputBytes) throw refusal('Image inputs exceed the processing byte budget');
    const filename = path.join(dir, `input-${state.index++}`);
    await fs.writeFile(filename, value, { flag: 'wx', mode: 0o600 });
    return { $buffer: filename };
  }
  if (Array.isArray(value)) return Promise.all(value.map(item => encode(item, dir, policy, state)));
  if (value && typeof value === 'object') {
    const result = {};
    for (const [key, item] of Object.entries(value)) result[key] = await encode(item, dir, policy, state);
    return result;
  }
  return value;
}
function decode(value) {
  if (value && typeof value === 'object' && value.$bytes) return Buffer.from(value.$bytes, 'base64');
  if (Array.isArray(value)) return value.map(decode);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, decode(item)]));
  return value;
}
async function execute(entry) {
  let dir;
  try {
    if (entry.done) throw entry.failure;
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'picpeak-image-'));
    const job = await encode(entry.job, dir, entry.policy, { bytes: 0, index: 0 });
    if (entry.done) throw entry.failure;
    const manifest = JSON.stringify({ ...job, policy: entry.policy, output: path.join(dir, 'output') });
    if (Buffer.byteLength(manifest) > 1024 * 1024) throw refusal('Image processing instructions exceed the budget');
    const result = await new Promise((resolve, reject) => {
      const child = spawn('/bin/sh', ['-c', 'ulimit -v "$1" || exit 125; exec "$2" --jitless --no-expose-wasm --max-old-space-size=64 "$3"', 'picpeak-image',
        String(Math.floor(entry.policy.nativeBytes / 1024)), process.execPath, path.join(__dirname, 'sharpWorker.js')],
      { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, VIPS_CONCURRENCY: '1', MALLOC_ARENA_MAX: '2' } });
      entry.child = child;
      let stdout = '', stderr = '';
      let spawnError;
      child.on('error', error => { spawnError = error; });
      child.stdout.on('data', chunk => {
        if (entry.done) return;
        stdout += chunk;
        if (Buffer.byteLength(stdout) > 1024 * 1024) entry.fail(refusal('Image worker response exceeds the budget', 'IMAGE_WORKER_FAILED'));
      });
      child.stderr.on('data', chunk => { if (stderr.length < 4096) stderr += chunk.toString().slice(0, 4096 - stderr.length); });
      child.stdin.on('error', () => {}); // A refused/crashed child may close its pipe early.
      child.on('close', (code, signal) => {
        entry.child = null;
        if (entry.done) return reject(entry.failure);
        if (spawnError || code !== 0) return reject(refusal(`Image worker could not complete (${signal || code})`, 'IMAGE_WORKER_FAILED'));
        try {
          const response = JSON.parse(stdout);
          if (response.error) return reject(Object.assign(new Error(response.error.message), { code: response.error.code, status: 422 }));
          resolve(response);
        } catch (_) { reject(refusal('Invalid image worker response', 'IMAGE_WORKER_FAILED')); }
      });
      if (entry.done) child.kill('SIGKILL');
      else child.stdin.end(manifest);
    });
    if (['metadata', 'metadataBatch'].includes(entry.job.terminal)) return decode(result.value);
    const stat = await fs.stat(path.join(dir, 'output'));
    if (stat.size > entry.policy.outputBytes) throw refusal('Image output exceeds the byte budget');
    const buffer = await fs.readFile(path.join(dir, 'output'));
    if (entry.done) throw entry.failure;
    if (entry.job.terminal === 'toFile') {
      // Never truncate a previously good derivative on timeout/native failure.
      const target = entry.job.target;
      const staging = `${target}.${path.basename(dir)}.tmp`;
      try {
        await fs.writeFile(staging, buffer, { flag: 'wx' });
        if (entry.done) throw entry.failure;
        await fs.rename(staging, target);
      }
      finally { await fs.unlink(staging).catch(() => {}); }
      return decode(result.info);
    }
    return entry.job.resolveWithObject ? { data: buffer, info: decode(result.info) } : buffer;
  } finally {
    clearTimeout(entry.timer);
    entry.signal?.removeEventListener('abort', entry.cancel);
    entry.done = true;
    try { if (dir) await fs.rm(dir, { recursive: true, force: true }); }
    finally { entry.releaseInputs(); }
  }
}
function submit(job, signal) {
  const policy = configuration();
  if (process.platform !== 'linux') return Promise.reject(refusal('Image processing requires the Linux hard-memory-limited runner', 'IMAGE_WORKER_UNAVAILABLE'));
  if (!policy.workers) return Promise.reject(refusal('Deployment memory is too small for the image worker', 'IMAGE_WORKER_UNAVAILABLE'));
  if (queue.length >= policy.queueLength) return Promise.reject(refusal('Image processing queue is full', 'IMAGE_QUEUE_FULL'));
  if (signal?.aborted) return Promise.reject(refusal('Image processing was cancelled', 'IMAGE_CANCELLED'));
  const countBytes = value => Buffer.isBuffer(value) ? value.length : Array.isArray(value)
    ? value.reduce((total, item) => total + countBytes(item), 0)
    : value && typeof value === 'object' ? Object.values(value).reduce((total, item) => total + countBytes(item), 0) : 0;
  const bytes = countBytes(job);
  if (bytes + retainedBytes > policy.inputBytes) return Promise.reject(refusal('Image input queue exceeds the byte budget', 'IMAGE_QUEUE_FULL'));
  retainedBytes += bytes;
  return new Promise((resolve, reject) => {
    const entry = { job, policy, signal, resolve, reject, done: false, running: false };
    let inputsReleased = false;
    entry.releaseInputs = () => { if (!inputsReleased) { retainedBytes -= bytes; inputsReleased = true; } };
    entry.fail = error => {
      if (entry.done) return;
      entry.done = true;
      entry.failure = error;
      if (entry.child) entry.child.kill('SIGKILL');
      // Return the refusal at the deadline, but retain the live native slot
      // and input accounting until the actual child close/cleanup completes.
      reject(error);
      if (!entry.running) {
        const index = queue.indexOf(entry);
        if (index >= 0) queue.splice(index, 1);
        clearTimeout(entry.timer);
        signal?.removeEventListener('abort', entry.cancel);
        entry.releaseInputs();
      }
    };
    entry.timer = setTimeout(() => entry.fail(refusal('Image processing deadline exceeded', 'IMAGE_TIMEOUT')), policy.timeoutMs);
    entry.cancel = () => entry.fail(refusal('Image processing was cancelled', 'IMAGE_CANCELLED'));
    signal?.addEventListener('abort', entry.cancel, { once: true });
    queue.push(entry);
    pump();
  });
}
function sharp(input, options = {}) {
  const steps = [];
  const chain = {};
  for (const name of methods) chain[name] = (...args) => { steps.push([name, args]); return chain; };
  const { signal, ...nativeOptions } = options;
  chain.metadata = () => submit({ input, options: nativeOptions, steps: [], terminal: 'metadata' }, signal);
  chain.toBuffer = (outputOptions = {}) => submit({ input, options: nativeOptions, steps, terminal: 'toBuffer', resolveWithObject: outputOptions.resolveWithObject === true }, signal);
  chain.toFile = target => submit({ input, options: nativeOptions, steps, terminal: 'toFile', target }, signal);
  return chain;
}
// Existing call sites set these soft settings. They cannot weaken the child.
sharp.cache = () => false;
sharp.concurrency = () => 1;
// Bounded header admission batches avoid one process start per small upload.
// This still executes entirely inside one hard-capped, deadline-bound child.
sharp.metadataBatch = (entries, { signal, validate = false } = {}) => submit({ entries, validate, terminal: 'metadataBatch' }, signal);
module.exports = sharp;
