/**
 * Runs ffmpeg, ffprobe and exiftool as child processes, a few at a time.
 *
 * Under the process guard when the host supports it (mediaCapabilities):
 * address-space/CPU/file limits, a thread budget and a kernel lease that
 * proves the last thread is gone. Otherwise as a plain child in its own
 * process group, with the same output caps and a timeout that ends the
 * group with SIGTERM, then SIGKILL. A guard that stops working mid-flight is
 * switched off and the job is run again without it; it is never the reason
 * a job fails.
 *
 * Two lanes: `long` (transcodes) and `short` (probes, posters, RAW
 * previews). Each lane always runs at least one job, so a rendition cannot
 * hold up thumbnails and a small host still processes media. A job's time
 * budget starts when it starts, not while it waits.
 */
const { spawn } = require('child_process');
const fs = require('fs').promises;
const crypto = require('crypto');
const path = require('path');
const imagePolicy = require('./imageResourcePolicy');
const { refusal } = imagePolicy;
const { parseStat } = require('./linuxProcessLease');
const attemptContext = require('./mediaAttemptContext');
const kernelLease = require('./linuxKernelLease');
const capabilities = require('./mediaCapabilities');

const MiB = 1024 * 1024;
// What a job without a memory cap of its own counts for in the pool.
const NOMINAL_BYTES = 768 * MiB;
const TERM_GRACE_MS = 2000;
const queue = [];
const active = new Set();
let reserved = 0;
let accepting = true;
const errorFor = (entry, message, suffix, detail) => refusal(message, `${entry.prefix}_${suffix}`, detail);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function count(name, fallback, maximum) {
  const value = parseInt(process.env[name] || '', 10);
  return Number.isSafeInteger(value) && value > 0 ? Math.min(value, maximum) : fallback;
}
function configuration() {
  return { bytes: Math.floor(imagePolicy.effectiveMemory() / 2),
    children: count('MEDIA_PROCESS_CONCURRENCY', 2, 16),
    longChildren: count('VIDEO_RENDITION_CONCURRENCY', 1, 8),
    queue: count('MEDIA_PROCESS_QUEUE_LENGTH', 256, 4096) };
}
function integer(value, maximum, label, { zero = false } = {}) {
  if (zero && value === 0) return 0;
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) throw new Error(`Invalid native ${label}`);
  return value;
}
function admissible(entry, policy) {
  let lane = 0;
  for (const other of active) if (other.lane === entry.lane) lane++;
  if (lane >= (entry.lane === 'long' ? policy.longChildren : policy.children)) return false;
  // Memory decides how many run side by side, never whether one runs at all.
  return lane === 0 || reserved + entry.charge <= policy.bytes;
}
function pump() {
  const policy = configuration();
  for (let index = 0; accepting && index < queue.length;) {
    if (!admissible(queue[index], policy)) { index++; continue; }
    const entry = queue.splice(index, 1)[0];
    active.add(entry); reserved += entry.charge;
    entry.running = true;
    entry.timer = setTimeout(() => entry.fail(errorFor(entry, `${path.basename(entry.command)} did not finish within ${entry.wallMs} ms`, 'TIMEOUT')), entry.wallMs);
    execute(entry).then(entry.resolve, entry.reject).finally(() => {
      clearTimeout(entry.timer); clearTimeout(entry.killTimer); entry.signal?.removeEventListener('abort', entry.abort);
      active.delete(entry); reserved -= entry.charge; entry.finished(); pump();
    });
  }
}
function groupAlive(pid) {
  if (!pid) return false;
  try { process.kill(-pid, 0); return true; } catch (error) { if (error.code === 'EPERM') return true; }
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}
function killGroup(pid, signal) {
  if (!pid) return;
  try { process.kill(-pid, signal); } catch (_) { /* Already gone, or never became a group. */ }
  try { process.kill(pid, signal); } catch (_) { /* Already gone. */ }
}
/**
 * Waits until a guarded job's last thread is gone. The free kernel lease is
 * the proof; without one (lease file removed, no lease at all) a process
 * group that stays gone for `graceMs` is taken as gone. Never waits longer
 * than `limitMs`: a job that cannot be reaped is reported, not waited on
 * forever. Resolves true when death was established.
 */
async function waitForNativeDeath(entry, { graceMs = 250, limitMs = 15000 } = {}) {
  const started = Date.now();
  let goneSince = null;
  for (;;) {
    const lease = entry.proofIdentity ? await kernelLease.probe(entry.leasePath, entry.proofIdentity) : 'unknown';
    if (lease === 'free') return true;
    if (groupAlive(entry.nativePid)) { goneSince = null; killGroup(entry.nativePid, 'SIGKILL'); }
    else if (lease !== 'busy') {
      goneSince ??= Date.now();
      if (Date.now() - goneSince >= graceMs) return true;
    }
    if (Date.now() - started >= limitMs) return false;
    await sleep(25);
  }
}
/** stdout to memory or `stdoutPath`, a little stderr for the error message. */
function collect(entry, child, writes) {
  const state = { stdout: [], stderr: [], stdoutBytes: 0, stderrBytes: 0, output: null };
  if (entry.stdoutPath) writes.push(fs.open(entry.stdoutPath, 'wx', 0o600).then(file => { state.output = file; }));
  child.stdin.on('error', () => {});
  child.stdout.on('data', chunk => {
    state.stdoutBytes += chunk.length;
    if (state.stdoutBytes > entry.outputBytes) return entry.fail(errorFor(entry, 'Native output exceeds the processing budget', 'OUTPUT_LIMIT'));
    if (entry.stdoutPath) {
      child.stdout.pause();
      const write = Promise.all(writes).then(() => state.output.writeFile(chunk)).then(() => child.stdout.resume());
      writes.push(write); write.catch(error => entry.fail(error));
    } else state.stdout.push(chunk);
  });
  child.stderr.on('data', chunk => {
    state.stderrBytes += chunk.length;
    if (state.stderrBytes > MiB) entry.fail(errorFor(entry, 'Native diagnostic output exceeds the budget', 'OUTPUT_LIMIT'));
    if (state.stderr.reduce((sum, value) => sum + value.length, 0) < 8192) state.stderr.push(chunk.subarray(0, 8192));
  });
  state.detail = () => Buffer.concat(state.stderr).toString().slice(0, 8192);
  state.result = () => ({ stdout: entry.stdoutPath ? undefined : Buffer.concat(state.stdout), stderr: Buffer.concat(state.stderr).toString() });
  return state;
}
const childEnvironment = entry => ({ ...process.env, OMP_NUM_THREADS: '1', OPENBLAS_NUM_THREADS: '1', VIPS_CONCURRENCY: '1', MALLOC_ARENA_MAX: '2', ...entry.env });
const failed = (entry, code, signal, detail) => Object.assign(
  new Error(`${path.basename(entry.command)} failed (${signal || code}): ${detail}`), { exitCode: code, signal });
// Identifies a PID across reuse; null where it cannot be read.
const startTicks = pid => fs.readFile(`/proc/${pid}/stat`, 'utf8').then(stat => parseStat(stat).startTicks, () => null);
const guardUnavailable = reason => Object.assign(new Error(reason), { guardUnavailable: true });

function supervised(entry) {
  return new Promise((resolve, reject) => {
    const child = spawn(capabilities.GUARD, [String(process.pid), String(entry.memoryBytes), String(entry.cpuSeconds),
      String(entry.fileBytes), String(entry.wallMs), String(entry.threads), entry.leasePath || '-', entry.command, ...entry.args], {
      stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe'], detached: true, env: childEnvironment(entry),
    });
    entry.child = child; entry.terminate = () => child.kill('SIGTERM');
    let spawnError, record = null, handshake = '';
    const writes = [];
    const io = collect(entry, child, writes);
    child.on('error', error => { spawnError = error; });
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
            if (entry.proofIdentity && (value.leaseDevice !== entry.proofIdentity.device || value.leaseInode !== entry.proofIdentity.inode ||
                value.leaseFilesystem !== entry.proofIdentity.filesystem)) {
              entry.fail(errorFor(entry, 'Native execution lease identity changed', 'WORKER_FAILED'));
              continue;
            }
            entry.nativePid = value.pid;
            const registration = Promise.all([startTicks(value.pid), startTicks(child.pid)]).then(async ([nativeStart, guardianStart]) => {
              entry.lease = { pid: value.pid, startTicks: nativeStart,
                guardianPid: child.pid, guardianStartTicks: guardianStart,
                ...(entry.proofIdentity ? { device: value.leaseDevice, inode: value.leaseInode, filesystem: value.leaseFilesystem } : {}) };
              await entry.onStart?.(entry.lease);
              if (!entry.failure) child.stdio[4].end('1');
            });
            writes.push(registration); registration.catch(error => entry.fail(error));
          }
          if (value.terminal === true) record = value;
        } catch (_) { entry.fail(errorFor(entry, 'Invalid native supervisor response', 'WORKER_FAILED')); }
      }
    });
    child.on('close', async code => {
      entry.child = null; entry.terminate = null;
      try {
        // A failed registration/output write is still pending work: drain
        // every write and see the job gone before the pool slot is released.
        const outcomes = await Promise.allSettled(writes);
        let teardownError = outcomes.find(outcome => outcome.status === 'rejected')?.reason;
        try { await io.output?.close(); } catch (error) { teardownError ||= error; }
        // A terminal record means the guardian reaped every thread itself;
        // the lease, where there is one, is the independent proof of that.
        if (entry.nativePid && (entry.proofIdentity || !record) && !(await waitForNativeDeath(entry))) {
          require('../utils/logger').warn('A native media job could not be confirmed gone; its slot is released', { command: path.basename(entry.command), pid: entry.nativePid });
        }
        try { await entry.onFinish?.(entry.lease); } catch (error) { teardownError ||= error; }
        if (entry.failure) throw entry.failure;
        if (spawnError) throw guardUnavailable(`the guard could not be started: ${spawnError.message}`);
        if (code === 123) throw errorFor(entry, 'Native execution lease is still held', 'LEASE_BUSY');
        // The guard says in its terminal record whether the command itself
        // ran and how it ended. An exit code alone cannot: a command may
        // exit 125 just as the guard does when it cannot supervise.
        if (!record) {
          if (!entry.nativePid) throw guardUnavailable(`the guard exited with ${code} before starting the command`);
          throw errorFor(entry, 'Native supervisor ended before its command was reaped', 'WORKER_UNAVAILABLE');
        }
        if (record.supervisorFailed) throw guardUnavailable('thread supervision (ptrace) failed');
        if (!record.executed) {
          if (record.exitCode === 127) throw Object.assign(new Error(`${entry.command} is not installed`), { code: 'ENOENT' });
          if (record.timedOut) throw errorFor(entry, 'Native processing deadline exceeded', 'TIMEOUT');
          throw guardUnavailable(`the guard could not apply its limits (${record.exitCode})`);
        }
        if (teardownError) throw teardownError;
        if (record.timedOut) throw errorFor(entry, 'Native processing deadline exceeded', 'TIMEOUT');
        if (record.cancelled) throw errorFor(entry, 'Native processing was cancelled', 'CANCELLED');
        if (record.exitCode !== 0 || record.threadLimit) {
          const detail = io.detail();
          // FFmpeg can exit with a wrapped negative errno (for example 234),
          // so only the guardian's actual signal proves a native kill.
          if (record.threadLimit || record.childSignal > 0 ||
              /cannot allocate memory|out of memory|memory allocation|resource temporarily unavailable/i.test(detail)) {
            throw errorFor(entry, 'Native processing exceeded its resource budget', 'RESOURCE_LIMIT', {
              exitCode: record.exitCode, signal: record.childSignal, threadLimit: record.threadLimit === true,
              cause: new Error(detail || 'Native child was signalled') });
          }
          throw failed(entry, record.exitCode, null, detail);
        }
        resolve(io.result());
      } catch (error) { reject(error); }
    });
    if (entry.failure) child.kill('SIGTERM');
    else child.stdin.end(entry.input);
  });
}
function plain(entry) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(entry.command, entry.args, { stdio: ['pipe', 'pipe', 'pipe'], detached: true, env: childEnvironment(entry) });
    } catch (error) { reject(error); return; }
    entry.child = child; entry.nativePid = child.pid;
    entry.terminate = () => {
      killGroup(child.pid, 'SIGTERM');
      entry.killTimer ||= setTimeout(() => killGroup(child.pid, 'SIGKILL'), TERM_GRACE_MS);
    };
    let spawnError;
    const writes = [];
    const io = collect(entry, child, writes);
    child.on('error', error => { spawnError = error; });
    if (child.pid) {
      const registration = Promise.resolve().then(() => entry.onStart?.({ pid: child.pid }));
      writes.push(registration); registration.catch(error => entry.fail(error));
    }
    child.on('close', async (code, signal) => {
      entry.child = null; entry.terminate = null;
      clearTimeout(entry.killTimer); entry.killTimer = null;
      // Whatever the command left behind in its group goes with it.
      killGroup(child.pid, 'SIGKILL');
      try {
        const outcomes = await Promise.allSettled(writes);
        let teardownError = outcomes.find(outcome => outcome.status === 'rejected')?.reason;
        try { await io.output?.close(); } catch (error) { teardownError ||= error; }
        try { await entry.onFinish?.(child.pid ? { pid: child.pid } : undefined); } catch (error) { teardownError ||= error; }
        if (entry.failure) throw entry.failure;
        if (spawnError) throw spawnError.code === 'ENOENT' ? Object.assign(new Error(`${entry.command} is not installed`), { code: 'ENOENT' }) : spawnError;
        if (teardownError) throw teardownError;
        if (code !== 0) throw failed(entry, code, signal, io.detail());
        resolve(io.result());
      } catch (error) { reject(error); }
    });
    if (entry.failure) entry.terminate();
    else child.stdin.end(entry.input);
  });
}
async function execute(entry) {
  if (entry.failure) throw entry.failure;
  const caps = capabilities.current();
  let ownedLease = false;
  try {
    if (caps.guard) {
      // Only the guard holds a lease for its child; a plain child has none.
      if (caps.leases) {
        if (!entry.leasePath) { entry.leasePath = path.join(caps.leaseRoot, `${crypto.randomUUID()}.exec.lease`); ownedLease = true; }
        try {
          const prepared = await kernelLease.acquire(entry.leasePath);
          entry.proofIdentity = { device: prepared.device, inode: prepared.inode, filesystem: prepared.filesystem };
          await prepared.release();
        } catch (error) {
          if (error.code === 'MEDIA_LEASE_BUSY') throw errorFor(entry, 'Native execution lease is still held', 'LEASE_BUSY');
          entry.leasePath = null; entry.proofIdentity = null;
        }
      } else entry.leasePath = null;
      try { return await supervised(entry); }
      catch (error) {
        if (!error.guardUnavailable || entry.failure) throw error;
        capabilities.downgrade('guard', error.message);
        if (entry.stdoutPath) await fs.rm(entry.stdoutPath, { force: true });
        entry.nativePid = null; entry.lease = null;
      }
    }
    return await plain(entry);
  } finally {
    // Never remove a caller's durable attempt lease, nor one still held.
    if (ownedLease && entry.leasePath && (!entry.proofIdentity || await kernelLease.probe(entry.leasePath, entry.proofIdentity) !== 'busy')) {
      await fs.rm(entry.leasePath, { force: true }).catch(() => {});
    }
  }
}
function createEntry(command, args, options) {
  const entry = { prefix: options.prefix || 'MEDIA', command, args,
    lane: options.lane === 'long' ? 'long' : 'short',
    // 0 = no address-space / CPU-time limit of its own (see mediaProcessPolicy).
    memoryBytes: integer(options.memoryBytes ?? NOMINAL_BYTES, 1024 * 1024 * MiB, 'memory budget', { zero: true }),
    cpuSeconds: integer(options.cpuSeconds ?? 30, 2592000, 'CPU budget', { zero: true }),
    wallMs: integer(options.wallMs || 30000, 604800000, 'wall budget'),
    outputBytes: integer(options.outputBytes || MiB, 64 * MiB, 'output budget'),
    fileBytes: integer(options.fileBytes || 64 * MiB, 1024 * 1024 * MiB, 'file budget'),
    threads: integer(options.threadLimit || 128, 256, 'thread budget'),
    signal: options.signal, input: options.input, stdoutPath: options.stdoutPath, env: options.env,
    onStart: options.onStart, onFinish: options.onFinish, leasePath: options.leasePath };
  entry.charge = (entry.memoryBytes || NOMINAL_BYTES) + 16 * MiB;
  entry.fail = error => {
    if (entry.failure) return;
    entry.failure = error;
    entry.terminate?.();
  };
  return entry;
}
async function run(command, args, options = {}) {
  const caps = await capabilities.probe();
  const attempt = attemptContext.current();
  if (attempt) {
    const hooks = attempt.hooks({ lease: caps.guard && caps.leases });
    const onStart = options.onStart, onFinish = options.onFinish;
    options = { ...options, leasePath: hooks.leasePath,
      signal: options.signal ? AbortSignal.any([options.signal, attempt.signal]) : attempt.signal,
      onStart: async lease => { await hooks.onStart(lease); await onStart?.(lease); },
      onFinish: async lease => { await hooks.onFinish(lease); await onFinish?.(lease); } };
  }
  const entry = createEntry(command, args, options);
  if (!accepting) throw errorFor(entry, 'Native processing is stopped', 'CANCELLED');
  if (entry.signal?.aborted) throw errorFor(entry, 'Native processing was cancelled', 'CANCELLED');
  // Queued photos and renditions wait their turn; only a caller outside a
  // queue attempt (a request) is told to come back later.
  if (!attempt && queue.length >= configuration().queue) throw errorFor(entry, 'Media processing is busy; try again shortly', 'QUEUE_FULL', { retryAfter: 5 });
  entry.settled = new Promise(resolve => { entry.finished = resolve; });
  return new Promise((resolve, reject) => {
    entry.resolve = resolve; entry.reject = reject;
    const fail = entry.fail;
    entry.fail = error => {
      if (entry.failure) return;
      fail(error);
      if (!entry.running) {
        const index = queue.indexOf(entry); if (index >= 0) queue.splice(index, 1);
        entry.signal?.removeEventListener('abort', entry.abort); entry.finished(); reject(error);
      }
    };
    entry.abort = () => entry.fail(errorFor(entry, 'Native processing was cancelled', 'CANCELLED'));
    entry.signal?.addEventListener('abort', entry.abort, { once: true });
    queue.push(entry); pump();
  });
}
/** One trivial guarded command: does ptrace/seccomp supervision work here? */
async function probeGuard() {
  const entry = createEntry('/bin/sh', ['-c', ':'], { memoryBytes: 512 * MiB, cpuSeconds: 5, wallMs: 10000, threadLimit: 16 });
  const timer = setTimeout(() => entry.fail(new Error('the guard did not answer within 10 s')), 10000);
  try { await supervised(entry); return { ok: true }; }
  catch (error) { return { ok: false, reason: error.message }; }
  finally { clearTimeout(timer); }
}
async function stop() {
  accepting = false;
  const entries = [...queue, ...active];
  for (const entry of entries) entry.fail(errorFor(entry, 'Native processing was stopped', 'CANCELLED'));
  await Promise.all(entries.map(entry => entry.settled));
}
function start() { accepting = true; pump(); }
module.exports = { run, stop, start, configuration, probeGuard, waitForNativeDeath };
