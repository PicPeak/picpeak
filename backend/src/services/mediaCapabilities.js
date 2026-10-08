/**
 * Which of the optional media protections this host can run. Probed once, at
 * first use (server.js asks at boot so the answer lands in the startup log).
 *
 *   guard   bin/media-process-guard supervises ffmpeg/ffprobe/exiftool:
 *           address-space/CPU/file limits, a thread budget, no fork. Needs
 *           Linux, the compiled binary, and ptrace + seccomp for its own child.
 *   leases  bin/local-process-lease.node holds a kernel flock per execution,
 *           so a crashed worker's photo is recovered as soon as the lock is
 *           free. Needs Linux, the compiled addon and a lease directory on a
 *           local filesystem.
 *
 * Neither is required. Without the guard the tools run as plain children
 * with timeouts and thread caps; without leases a stuck photo is recovered
 * by age, as before. Nothing here ever refuses media work.
 */
const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const logger = require('../utils/logger');

const GUARD = path.join(__dirname, '../../bin/media-process-guard');
const ADDON = path.join(__dirname, '../../bin/local-process-lease.node');
const DATA_DIRECTORY = path.join(__dirname, '../../data');
const BUILD_HINT = 'run `npm run build:native` in backend/ with a C compiler and the Node headers installed (the Docker images do this)';

let state = null;
let pending = null;
const off = () => ({ platform: process.platform, guard: false, leases: false, leaseRoot: null, host: null, reasons: {} });

function loadAddon() { return require(ADDON); }

/** Candidate lease directories, most preferred first. All must be local. */
function leaseCandidates() {
  const configured = process.env.MEDIA_PROCESS_LEASE_PATH;
  return [...(configured && path.isAbsolute(configured) ? [configured] : []),
    path.join(os.tmpdir(), 'picpeak-media-leases'), path.join(DATA_DIRECTORY, 'media-process-leases')];
}
async function probeLeases(result) {
  if (process.platform !== 'linux') { result.reasons.leases = `kernel leases need Linux and this host is ${process.platform}`; return; }
  let addon;
  try { addon = module.exports.loadAddon(); }
  catch (_) { result.reasons.leases = `bin/local-process-lease.node is not built; ${BUILD_HINT}`; return; }
  const refused = [];
  if (process.env.MEDIA_PROCESS_LEASE_PATH && !path.isAbsolute(process.env.MEDIA_PROCESS_LEASE_PATH)) refused.push(`${process.env.MEDIA_PROCESS_LEASE_PATH} (not absolute)`);
  for (const directory of leaseCandidates()) {
    const probe = path.join(directory, `.probe-${process.pid}.lease`);
    try {
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      const root = await fs.realpath(directory);
      addon.release(addon.acquire(path.join(root, path.basename(probe))).descriptor);
      result.leases = true; result.leaseRoot = root;
      if (refused.length) result.reasons.leaseFallback = `${refused.join(', ')} refused; using ${root}`;
      return;
    } catch (error) { refused.push(`${directory} (${error.code === 'EACCES' ? 'not writable' : 'not a local ext4/xfs/btrfs/tmpfs/overlay/zfs filesystem, or not writable'})`); }
    finally { await fs.unlink(probe).catch(() => {}); }
  }
  result.reasons.leases = `no usable lease directory: ${refused.join(', ')}; set MEDIA_PROCESS_LEASE_PATH to a directory on a local disk`;
}
async function probeGuard(result) {
  if (process.platform !== 'linux') { result.reasons.guard = `the process guard needs Linux and this host is ${process.platform}`; return; }
  try { await fs.access(module.exports.GUARD, require('fs').constants.X_OK); }
  catch (_) { result.reasons.guard = `bin/media-process-guard is not built; ${BUILD_HINT}`; return; }
  const outcome = await require('./nativeProcessRunner').probeGuard();
  if (outcome.ok) result.guard = true;
  else result.reasons.guard = `the guard could not supervise a test process (${outcome.reason}); allow ptrace and seccomp for the container (Docker's default profile does; a custom seccomp profile or kernel.yama.ptrace_scope=3 does not)`;
}
function describe(value) {
  const part = (name, on, detail, reason) => on ? `${name} ON${detail ? ` (${detail})` : ''}` : `${name} OFF: ${reason}`;
  return ['Media process protections:',
    part('process guard', value.guard, 'memory/CPU/thread limits for ffmpeg, ffprobe, exiftool', `${value.reasons.guard}. The tools run unguarded, with timeouts and thread caps`),
    `| ${part('kernel leases', value.leases, [value.leaseRoot, value.reasons.leaseFallback].filter(Boolean).join('; '), `${value.reasons.leases}. Interrupted work is recovered by age`)}`,
    `| host identity: ${value.host?.source || 'none'}${value.host?.detail ? ` (${value.host.detail})` : ''}`].join(' ');
}
/** The decision, made once. Never rejects. */
function probe() {
  if (state) return Promise.resolve(state);
  if (!pending) {
    pending = (async () => {
      const result = off();
      try { await probeLeases(result); } catch (error) { result.reasons.leases = error.message; }
      try { await probeGuard(result); } catch (error) { result.reasons.guard = error.message; }
      try { result.host = await require('./linuxProcessLease').hostIdentity(); } catch (error) { result.host = { host: null, source: 'none', detail: error.message }; }
      state = result;
      // Expected on macOS/Windows development; worth a warning on Linux.
      logger[process.platform === 'linux' && !(result.guard && result.leases) ? 'warn' : 'info'](describe(result));
      return result;
    })();
  }
  return pending;
}
/** A protection that stopped working at runtime is switched off, once, loudly. */
function downgrade(name, reason) {
  if (!state || !state[name]) return;
  state[name] = false; state.reasons[name] = reason;
  if (name === 'leases') state.leaseRoot = null;
  logger.warn(`Media ${name === 'guard' ? 'process guard' : 'kernel leases'} switched off: ${reason}. Media processing continues without ${name === 'guard' ? 'it' : 'them'}.`);
}
module.exports = { probe, downgrade, describe, loadAddon, GUARD, DATA_DIRECTORY,
  current: () => state || off(),
  // Tests only: replace or forget the decision.
  set: value => { state = value ? { ...off(), ...value, reasons: value.reasons || {} } : null; pending = null; } };
