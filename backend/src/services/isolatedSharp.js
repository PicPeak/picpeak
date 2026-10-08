/** Sharp-compatible subset used by PicPeak. Native code runs in a small pool of
 * warm child processes; `resolveMode` picks the strongest isolation the host
 * supports and says so once, loudly, when it has to settle for less. */
const fs = require('fs').promises;
const { constants: fsConstants } = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const logger = require('../utils/logger');
const { configuration, refusal, MiB } = require('./imageResourcePolicy');

const methods = ['rotate', 'withMetadata', 'keepMetadata', 'resize', 'jpeg', 'png', 'webp', 'gif', 'extract', 'composite'];
const WORKER = path.join(__dirname, 'sharpWorker.js');
const NODE_FLAGS = ['--jitless', '--no-expose-wasm', '--max-old-space-size=64'];
const MESSAGE_BYTES = 1024 * 1024;
const READY_MS = 15000;
const IDLE_MS = 30000;
// A warm worker is replaced after this many jobs, after any failed job and
// always after one that hit a resource limit.
const RECYCLE_AFTER = 50;
// The image parser gets no application secrets: only what node, libvips and
// fontconfig read. Everything else in process.env stays in the backend.
const ENV_NAMES = new Set(['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ',
  'LD_LIBRARY_PATH', 'LD_PRELOAD', 'FONTCONFIG_PATH', 'FONTCONFIG_FILE', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME',
  'SystemRoot', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']);
function childEnvironment() {
  const env = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (ENV_NAMES.has(name) || /^(VIPS_|MALLOC_)/.test(name)) env[name] = value;
  }
  return { ...env, VIPS_CONCURRENCY: '1', MALLOC_ARENA_MAX: '2' };
}

let active = 0;
let exclusiveActive = false;
const queue = [];
const idle = [];
let modePromise = null;

function setReferenced(worker, referenced) {
  // An idle worker must not keep a script or a test run alive.
  for (const handle of [worker.child, worker.child.stdin, worker.child.stdout, worker.child.stderr]) {
    if (handle && typeof handle.ref === 'function') handle[referenced ? 'ref' : 'unref']();
  }
}
function retire(worker) {
  const index = idle.indexOf(worker);
  if (index >= 0) idle.splice(index, 1);
  clearTimeout(worker.idleTimer);
  if (!worker.closed) worker.child.kill('SIGKILL');
  return worker.exited;
}
function park(worker) {
  setReferenced(worker, false);
  worker.idleTimer = setTimeout(() => retire(worker), IDLE_MS);
  worker.idleTimer.unref();
  idle.push(worker);
}
function startWorker(mode, cap) {
  return new Promise((resolve, reject) => {
    const options = { stdio: ['pipe', 'pipe', 'pipe'], env: childEnvironment() };
    // `exec` replaces the shell, so the limit costs no extra process and the
    // shell runs once per worker, not once per image.
    let child;
    try {
      child = mode === 'capped'
        ? spawn('/bin/sh', ['-c', 'ulimit -v "$1" || exit 125; shift; exec "$@"', 'picpeak-image',
          String(Math.floor(cap / 1024)), process.execPath, ...NODE_FLAGS, WORKER, String(cap)], options)
        : spawn(process.execPath, [...NODE_FLAGS, WORKER, '0'], options);
    } catch (error) { reject({ error }); return; }
    const worker = { child, mode, cap, jobs: 0, pending: '', current: null, ready: false, closed: false };
    worker.exited = new Promise(done => { worker.onExit = done; });
    const readyTimer = setTimeout(() => child.kill('SIGKILL'), READY_MS);
    const close = (code, signal, error) => {
      if (worker.closed) return;
      worker.closed = true;
      clearTimeout(readyTimer);
      retire(worker);
      const exit = { code, signal, error };
      if (!worker.ready) reject(exit);
      if (worker.current) { worker.current.reject(exit); worker.current = null; }
      worker.onExit();
    };
    child.on('error', error => close(null, null, error));
    child.on('close', (code, signal) => close(code, signal));
    child.stdin.on('error', () => {}); // A crashed child may close its pipe early.
    child.stderr.on('data', () => {}); // libvips warnings; never buffered.
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      worker.pending += chunk;
      let index;
      while ((index = worker.pending.indexOf('\n')) >= 0) {
        const line = worker.pending.slice(0, index);
        worker.pending = worker.pending.slice(index + 1);
        if (!worker.ready) {
          worker.ready = true;
          clearTimeout(readyTimer);
          resolve(worker);
        } else if (worker.current) {
          const { resolve: deliver } = worker.current;
          worker.current = null;
          deliver(line);
        }
      }
      if (worker.pending.length > 2 * MESSAGE_BYTES) { worker.overflow = true; child.kill('SIGKILL'); }
    });
  });
}
const startFailure = exit => exit.error ? exit.error.message
  : exit.code === 125 ? 'this system does not apply `ulimit -v`'
    : exit.code === 126 ? 'sharp could not be loaded in the child'
      : `it ended with ${exit.signal || `exit code ${exit.code}`} before it was ready`;
/**
 * capped:    child under an address-space limit (Linux). The full protection.
 * child:     plain child process. A crash or runaway allocation stays out of
 *            the backend, but nothing caps the child's memory.
 * inprocess: sharp inside the backend, as before the runner existed.
 * The pixel limit is enforced in every mode. Decided once, at first use.
 */
function resolveMode(policy) {
  if (!modePromise) {
    modePromise = (async () => {
      let reason;
      if (process.platform === 'linux') {
        try { park(await startWorker('capped', policy.nativeBytes)); return 'capped'; }
        catch (exit) { reason = `the memory-limited image worker (${policy.nativeBytes / MiB} MiB) did not start: ${startFailure(exit)}`; }
      } else {
        reason = `the per-worker memory limit needs Linux and this host is ${process.platform}`;
      }
      try {
        park(await startWorker('child', policy.nativeBytes));
        logger.warn(`IMAGE PROCESSING RUNS WITHOUT ITS MEMORY LIMIT: ${reason}. Images are still parsed in a separate process and ` +
          'the pixel limit still applies, but a huge or hostile image can use memory up to the host or container limit.');
        return 'child';
      } catch (exit) {
        logger.warn(`IMAGE PROCESSING RUNS INSIDE THE BACKEND PROCESS: ${reason}, and a plain image worker did not start either ` +
          `(${startFailure(exit)}). The pixel limit still applies, but a crash or memory exhaustion in the image library now takes the backend down with it.`);
        return 'inprocess';
      }
    })();
  }
  return modePromise;
}
async function acquire(mode, cap) {
  let worker;
  while ((worker = idle.pop())) {
    clearTimeout(worker.idleTimer);
    if (!worker.closed && worker.cap === cap) break;
    retire(worker);
  }
  if (!worker) {
    try { worker = await startWorker(mode, cap); }
    catch (exit) { throw refusal(`Image worker could not be started: ${startFailure(exit)}`, 'IMAGE_WORKER_UNAVAILABLE'); }
  }
  setReferenced(worker, true);
  return worker;
}
const workerError = error => refusal(error.message, error.code,
  error.imageLimit ? { imageLimit: error.imageLimit, imageMax: error.imageMax } : undefined);
// The worker ran out of its address space (or died trying): `memory` lets
// the queue give the job one more run, alone, with the whole image budget.
const outOfMemory = (message, worker) => refusal(
  `${message}; the image worker runs under a ${worker.cap / MiB} MiB memory limit (IMAGE_WORKER_MEMORY_MIB)`,
  'IMAGE_RESOURCE_LIMIT', { imageLimit: 'memory', imageMax: worker.cap / MiB, memory: true });
async function viaWorker(entry, mode, manifest) {
  const worker = await acquire(mode, entry.exclusive ? entry.policy.exclusiveBytes : entry.policy.nativeBytes);
  if (entry.done) { await retire(worker); throw entry.failure; }
  entry.worker = worker;
  let line;
  try {
    line = await new Promise((resolve, reject) => {
      worker.current = { resolve, reject };
      worker.child.stdin.write(`${manifest}\n`);
    });
  } catch (exit) {
    // The slot stays taken until the child is really gone.
    await worker.exited;
    if (entry.done) throw entry.failure;
    if (worker.overflow) throw refusal('Image worker response exceeds the budget', 'IMAGE_WORKER_FAILED');
    if (mode === 'capped') throw outOfMemory(`Image worker ended unexpectedly (${exit.signal || exit.code})`, worker);
    throw refusal(`Image worker could not complete (${exit.signal || exit.code})`, 'IMAGE_WORKER_FAILED');
  } finally { entry.worker = null; }
  worker.jobs++;
  let response;
  try { response = JSON.parse(line); }
  catch (_) { await retire(worker); throw refusal('Invalid image worker response', 'IMAGE_WORKER_FAILED'); }
  if (response.error || entry.done || worker.jobs >= RECYCLE_AFTER) await retire(worker);
  else park(worker);
  if (entry.done) throw entry.failure;
  if (response.error) {
    if (mode === 'capped' && response.error.code === 'IMAGE_RESOURCE_LIMIT' && !response.error.imageLimit) throw outOfMemory(response.error.message, worker);
    throw workerError(response.error);
  }
  return response;
}
async function inProcess(manifest) {
  const { run, serializeError } = require('./sharpWorker');
  try { return await run(JSON.parse(manifest)); }
  catch (error) { throw workerError(serializeError(error)); }
}
async function encode(value, dir, state) {
  if (Buffer.isBuffer(value)) {
    const filename = path.join(dir, `input-${state.index++}`);
    await fs.writeFile(filename, value, { flag: 'wx', mode: 0o600 });
    return { $buffer: filename };
  }
  if (Array.isArray(value)) {
    const result = [];
    for (const item of value) result.push(await encode(item, dir, state));
    return result;
  }
  if (value && typeof value === 'object') {
    const result = {};
    for (const [key, item] of Object.entries(value)) result[key] = await encode(item, dir, state);
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
  const { policy } = entry;
  let dir;
  try {
    // The deadline covers the work, not the wait for a free worker.
    entry.timer = setTimeout(() => entry.fail(refusal(`Image processing did not finish within ${policy.timeoutMs} ms (IMAGE_WORKER_TIMEOUT_MS)`, 'IMAGE_TIMEOUT')), policy.timeoutMs);
    const mode = await resolveMode(policy);
    if (entry.done) throw entry.failure;
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'picpeak-image-'));
    const job = await encode(entry.job, dir, { index: 0 });
    if (entry.done) throw entry.failure;
    const output = path.join(dir, `output${entry.job.terminal === 'toFile' ? path.extname(entry.job.target) : ''}`);
    const manifest = JSON.stringify({ ...job, policy, output });
    if (Buffer.byteLength(manifest) > MESSAGE_BYTES) throw refusal('Image processing instructions exceed the budget');
    const result = mode === 'inprocess' ? await inProcess(manifest) : await viaWorker(entry, mode, manifest);
    if (entry.done) throw entry.failure;
    if (['metadata', 'metadataBatch'].includes(entry.job.terminal)) return decode(result.value);
    const stat = await fs.stat(output);
    if (stat.size > policy.outputBytes) throw refusal(`Image output exceeds ${policy.outputBytes / MiB} MiB`);
    if (entry.job.terminal === 'toFile') {
      // Never truncate a previously good derivative on timeout/native failure.
      const target = entry.job.target;
      const staging = `${target}.${path.basename(dir)}.tmp`;
      try {
        await fs.copyFile(output, staging, fsConstants.COPYFILE_EXCL);
        if (entry.done) throw entry.failure;
        await fs.rename(staging, target);
      }
      finally { await fs.unlink(staging).catch(() => {}); }
      return decode(result.info);
    }
    const buffer = await fs.readFile(output);
    if (entry.done) throw entry.failure;
    return entry.job.resolveWithObject ? { data: buffer, info: decode(result.info) } : buffer;
  } finally {
    clearTimeout(entry.timer);
    if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
function pump() {
  while (queue.length) {
    const entry = queue[0];
    // An exclusive job runs alone; everything behind it waits its turn.
    if (exclusiveActive || (entry.exclusive ? active > 0 : active >= entry.policy.workers)) return;
    queue.shift();
    active++;
    exclusiveActive = Boolean(entry.exclusive);
    entry.running = true;
    const settle = () => { entry.done = true; entry.signal?.removeEventListener('abort', entry.cancel); };
    execute(entry).then(value => { settle(); entry.resolve(value); }, error => {
      const { policy } = entry;
      if (error.memory && !entry.done && !entry.exclusive && policy.exclusiveBytes > policy.nativeBytes) {
        // A large image that did not fit a shared worker: once more, alone.
        entry.exclusive = true;
        entry.running = false;
        queue.unshift(entry);
        return;
      }
      settle();
      entry.reject(error);
    }).finally(() => { active--; exclusiveActive = false; pump(); });
  }
}
/**
 * Background work (the default) waits for a free worker however long the
 * queue is: back-pressure, never a refusal. A caller that answers a request
 * passes `interactive: true` and gets IMAGE_QUEUE_FULL (503) instead of
 * joining a queue that is already `queueLength` deep.
 */
function submit(job, { signal, interactive } = {}) {
  let policy;
  try { policy = configuration(); } catch (error) { return Promise.reject(error); }
  if (signal?.aborted) return Promise.reject(refusal('Image processing was cancelled', 'IMAGE_CANCELLED'));
  if (interactive && queue.length >= policy.queueLength) {
    return Promise.reject(refusal('Image processing is busy; try again shortly', 'IMAGE_QUEUE_FULL', { retryAfter: 5 }));
  }
  return new Promise((resolve, reject) => {
    const entry = { job, policy, signal, resolve, reject, done: false, running: false, worker: null };
    entry.fail = error => {
      if (entry.done) return;
      entry.done = true;
      entry.failure = error;
      // Answer at once; a running job keeps its slot until its child is gone.
      reject(error);
      if (entry.worker) retire(entry.worker);
      if (!entry.running) {
        const index = queue.indexOf(entry);
        if (index >= 0) queue.splice(index, 1);
        signal?.removeEventListener('abort', entry.cancel);
      }
    };
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
  const { signal, interactive, ...nativeOptions } = options;
  const queueing = { signal, interactive };
  chain.metadata = () => submit({ input, options: nativeOptions, steps: [], terminal: 'metadata' }, queueing);
  chain.toBuffer = (outputOptions = {}) => submit({ input, options: nativeOptions, steps, terminal: 'toBuffer', resolveWithObject: outputOptions.resolveWithObject === true }, queueing);
  chain.toFile = target => submit({ input, options: nativeOptions, steps, terminal: 'toFile', target }, queueing);
  return chain;
}
// Existing call sites set these soft settings. They cannot weaken the child.
sharp.cache = () => false;
sharp.concurrency = () => 1;
// Bounded header admission batches avoid one job per small upload.
sharp.metadataBatch = (entries, { signal, interactive, validate = false } = {}) =>
  submit({ entries, validate, terminal: 'metadataBatch' }, { signal, interactive });
/** Decide the isolation mode now, so its warning lands in the startup log. */
sharp.prepare = () => resolveMode(configuration());
/** Stop the idle workers (shutdown, tests). Running jobs finish first. */
sharp.shutdown = () => Promise.all([...idle].map(retire));
module.exports = sharp;
