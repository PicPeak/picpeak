const { spawn } = require('child_process');
const fs = require('fs').promises;
const path = require('path');
const { effectiveMemory } = require('./imageResourcePolicy');
const { parseStat } = require('./linuxProcessLease');
const attemptContext = require('./mediaAttemptContext');

const GUARD = path.join(__dirname, '../../bin/media-process-guard');
const MiB = 1024 * 1024;
const queue = [];
const active = new Set();
let reserved = 0;
let accepting = true;
const errorFor = (entry, message, suffix) => Object.assign(new Error(message), { code: `${entry.prefix}_${suffix}`, status: 422 });
function configuration() { return { bytes: Math.floor(effectiveMemory() / 2), children: 2, queue: 32 }; }
function integer(value, maximum, label) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) throw new Error(`Invalid native ${label}`);
  return value;
}
function pump() {
  const policy = configuration();
  while (accepting && queue.length && active.size < policy.children) {
    const index = queue.findIndex(entry => entry.memoryBytes + 16 * MiB + reserved <= policy.bytes);
    if (index < 0) return;
    const entry = queue.splice(index, 1)[0];
    active.add(entry); reserved += entry.memoryBytes + 16 * MiB;
    entry.running = true;
    execute(entry).then(entry.resolve, entry.reject).finally(() => {
      clearTimeout(entry.timer); entry.signal?.removeEventListener('abort', entry.abort);
      active.delete(entry); reserved -= entry.memoryBytes + 16 * MiB; entry.finished(); pump();
    });
  }
}
async function waitForNativeDeath(entry) {
  // Abnormal supervisor death is not terminal proof. The seccomp filter
  // permits no additional processes, and PDEATHSIG kills this exact child.
  // Wait for its disappearance/zombie state before releasing work or storage.
  if (!entry.nativePid) return;
  for (;;) {
    try {
      const value = parseStat(await fs.readFile(`/proc/${entry.nativePid}/stat`, 'utf8'));
      if (entry.nativeStart && value.startTicks !== entry.nativeStart || ['Z', 'X'].includes(value.state)) return;
      if (!entry.nativeStart) entry.nativeStart = value.startTicks;
      try { process.kill(-entry.nativePid, 'SIGKILL'); } catch (_) { /* Confirm below, not from kill's return. */ }
    } catch (error) { if (['ENOENT', 'ESRCH'].includes(error.code)) return; }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}
async function execute(entry) {
  if (entry.failure) throw entry.failure;
  const remaining = entry.deadline - Date.now();
  if (remaining <= 0) throw errorFor(entry, 'Native processing deadline exceeded', 'TIMEOUT');
  const result = await new Promise((resolve, reject) => {
    const child = spawn(GUARD, [String(process.pid), String(entry.memoryBytes), String(entry.cpuSeconds),
      String(entry.fileBytes), String(remaining), '128', entry.leasePath || '-', entry.command, ...entry.args], {
      stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe'], detached: true,
      env: { ...process.env, OMP_NUM_THREADS: '1', OPENBLAS_NUM_THREADS: '1', VIPS_CONCURRENCY: '1', MALLOC_ARENA_MAX: '2', ...entry.env },
    });
    entry.child = child;
    let spawnError, terminal = false, nativeSignal, handshake = '', stdoutBytes = 0, stderrBytes = 0;
    const stdout = [], stderr = [];
    const writes = [];
    let output;
    if (entry.stdoutPath) writes.push(fs.open(entry.stdoutPath, 'wx', 0o600).then(file => { output = file; }));
    child.on('error', error => { spawnError = error; });
    child.stdin.on('error', () => {});
    child.stdio[4].on('error', () => {});
    child.stdio[3].on('data', chunk => {
      handshake += chunk.toString();
      if (Buffer.byteLength(handshake) > 4096) return entry.fail(errorFor(entry, 'Invalid native supervisor response', 'WORKER_FAILED'));
      for (;;) {
        const end = handshake.indexOf('\n'); if (end < 0) break;
        const line = handshake.slice(0, end); handshake = handshake.slice(end + 1);
        try {
          const value = JSON.parse(line);
          if (value.version === 1 && Number.isSafeInteger(value.pid) && value.pid > 0 && value.group === value.pid) {
            entry.nativePid = value.pid;
            const registration = Promise.all([
              fs.readFile(`/proc/${value.pid}/stat`, 'utf8'), fs.readFile(`/proc/${child.pid}/stat`, 'utf8'),
            ]).then(async ([stat, guardianStat]) => {
              entry.nativeStart = parseStat(stat).startTicks;
              entry.lease = { pid: value.pid, startTicks: entry.nativeStart,
                guardianPid: child.pid, guardianStartTicks: parseStat(guardianStat).startTicks,
                device: value.leaseDevice, inode: value.leaseInode, filesystem: value.leaseFilesystem };
              await entry.onStart?.(entry.lease);
              if (!entry.failure) child.stdio[4].end('1');
            });
            writes.push(registration); registration.catch(error => entry.fail(error));
          }
          if (value.terminal === true) {
            terminal = true;
            if (Number.isSafeInteger(value.childSignal) && value.childSignal >= 0) nativeSignal = value.childSignal;
          }
        } catch (_) { entry.fail(errorFor(entry, 'Invalid native supervisor response', 'WORKER_FAILED')); }
      }
    });
    child.stdout.on('data', chunk => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > entry.outputBytes) return entry.fail(errorFor(entry, 'Native output exceeds the processing budget', 'OUTPUT_LIMIT'));
      if (entry.stdoutPath) {
        child.stdout.pause();
        const write = Promise.all(writes).then(() => output.writeFile(chunk)).then(() => child.stdout.resume());
        writes.push(write); write.catch(error => entry.fail(error));
      } else stdout.push(chunk);
    });
    child.stderr.on('data', chunk => {
      stderrBytes += chunk.length;
      if (stderrBytes > 1024 * 1024) entry.fail(errorFor(entry, 'Native diagnostic output exceeds the budget', 'OUTPUT_LIMIT'));
      if (stderr.reduce((sum, value) => sum + value.length, 0) < 8192) stderr.push(chunk.subarray(0, 8192));
    });
    child.on('close', async (code, signal) => {
      entry.child = null;
      try {
        // A failed registration/output write is still pending execution work.
        // Drain every write and prove death before releasing pool capacity,
        // even when the first write rejected or the guardian died abnormally.
        const outcomes = await Promise.allSettled(writes);
        let teardownError = outcomes.find(outcome => outcome.status === 'rejected')?.reason;
        try { await output?.close(); } catch (error) { teardownError ||= error; }
        if (!terminal && child.pid) {
          // An abnormal guardian exit before its child identity arrived is
          // not proof of termination. Keep the lease fenced rather than
          // authorizing a retry or restore against an unknown execution.
          if (!entry.nativePid && !spawnError && ![123, 125].includes(code)) await new Promise(() => {});
          await waitForNativeDeath(entry);
        }
        try { await entry.onFinish?.(entry.lease); } catch (error) { teardownError ||= error; }
        if (entry.failure) throw entry.failure;
        if (teardownError) throw teardownError;
        if (spawnError || code === 125) throw errorFor(entry, 'Linux native media supervisor is unavailable; run npm run build:native with a C compiler', 'WORKER_UNAVAILABLE');
        if (code === 123) throw errorFor(entry, 'Native execution lease is still held', 'LEASE_BUSY');
        if (code === 127) throw Object.assign(new Error(`${entry.command} is not installed`), { code: 'ENOENT' });
        if (code === 124) throw errorFor(entry, 'Native processing deadline exceeded', 'TIMEOUT');
        if (!terminal) throw errorFor(entry, 'Native supervisor failed after confirmed child termination', 'WORKER_FAILED');
        if (!terminal || code !== 0) {
          const detail = Buffer.concat(stderr).toString().slice(0, 8192);
          // FFmpeg can exit with a wrapped negative errno (for example 234),
          // so only the guardian's actual signal proves a native kill.
          if ((nativeSignal === undefined ? code >= 128 : nativeSignal > 0) ||
              /cannot allocate memory|out of memory|memory allocation|resource temporarily unavailable/i.test(detail)) {
            throw errorFor(entry, 'Native processing exceeded its resource budget', 'RESOURCE_LIMIT');
          }
          throw Object.assign(new Error(`${path.basename(entry.command)} failed (${signal || code}): ${detail}`), { exitCode: code, signal });
        }
        resolve({ stdout: entry.stdoutPath ? undefined : Buffer.concat(stdout), stderr: Buffer.concat(stderr).toString() });
      } catch (error) { reject(error); }
    });
    if (entry.failure) child.kill('SIGTERM');
    else child.stdin.end(entry.input);
  });
  return result;
}
function run(command, args, options = {}) {
  const attempt = attemptContext.current();
  if (attempt) {
    const hooks = attempt.hooks();
    const onStart = options.onStart, onFinish = options.onFinish;
    options = { ...options, leasePath: hooks.leasePath,
      signal: options.signal ? AbortSignal.any([options.signal, attempt.signal]) : attempt.signal,
      wallMs: Math.min(options.wallMs || 30000, attempt.deadline - Date.now()),
      onStart: async lease => { await hooks.onStart(lease); await onStart?.(lease); },
      onFinish: async lease => { await hooks.onFinish(lease); await onFinish?.(lease); } };
  }
  const prefix = options.prefix || 'MEDIA';
  const entry = { prefix };
  if (process.platform !== 'linux') return Promise.reject(errorFor(entry, 'Native media processing requires Linux', 'WORKER_UNAVAILABLE'));
  if (!accepting) return Promise.reject(errorFor(entry, 'Native processing is stopped', 'CANCELLED'));
  if (options.wallMs !== undefined && options.wallMs <= 0) return Promise.reject(errorFor(entry, 'Native processing deadline exceeded', 'TIMEOUT'));
  const memoryBytes = integer(options.memoryBytes || 768 * MiB, 4096 * MiB, 'memory budget');
  const wallMs = integer(options.wallMs || 30000, 7200000, 'wall budget');
  if (memoryBytes + 16 * MiB > configuration().bytes) return Promise.reject(errorFor(entry, 'Deployment memory is too small for this native job', 'WORKER_UNAVAILABLE'));
  if (queue.length >= configuration().queue) return Promise.reject(errorFor(entry, 'Native processing queue is full', 'QUEUE_FULL'));
  if (options.signal?.aborted) return Promise.reject(errorFor(entry, 'Native processing was cancelled', 'CANCELLED'));
  Object.assign(entry, { command, args, memoryBytes, outputBytes: integer(options.outputBytes || MiB, 64 * MiB, 'output budget'),
    fileBytes: integer(options.fileBytes || 64 * MiB, 10 * 1024 * MiB, 'file budget'),
    cpuSeconds: integer(options.cpuSeconds || 30, 7200, 'CPU budget'), deadline: Date.now() + wallMs,
    signal: options.signal, input: options.input, stdoutPath: options.stdoutPath, env: options.env,
    onStart: options.onStart, onFinish: options.onFinish, leasePath: options.leasePath });
  entry.settled = new Promise(resolve => { entry.finished = resolve; });
  return new Promise((resolve, reject) => {
    entry.resolve = resolve; entry.reject = reject;
    entry.fail = error => {
      if (entry.failure) return; entry.failure = error;
      if (entry.child) entry.child.kill('SIGTERM');
      if (!entry.running) {
        const index = queue.indexOf(entry); if (index >= 0) queue.splice(index, 1);
        clearTimeout(entry.timer); entry.signal?.removeEventListener('abort', entry.abort); entry.finished(); reject(error);
      }
    };
    entry.timer = setTimeout(() => entry.fail(errorFor(entry, 'Native processing deadline exceeded', 'TIMEOUT')), wallMs);
    entry.abort = () => entry.fail(errorFor(entry, 'Native processing was cancelled', 'CANCELLED'));
    entry.signal?.addEventListener('abort', entry.abort, { once: true });
    queue.push(entry); pump();
  });
}
async function stop() {
  accepting = false;
  const entries = [...queue, ...active];
  for (const entry of entries) entry.fail(errorFor(entry, 'Native processing was stopped', 'CANCELLED'));
  await Promise.all(entries.map(entry => entry.settled));
}
function start() { accepting = true; pump(); }
module.exports = { run, stop, start, configuration };
