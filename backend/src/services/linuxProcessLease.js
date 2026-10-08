const fs = require('fs').promises;
const crypto = require('crypto');
const path = require('path');

const digest = value => crypto.createHash('sha256').update(value).digest('hex');
async function read(filename) { return (await fs.readFile(filename, 'utf8')).trim(); }
function parseStat(value) {
  // comm may contain spaces and parentheses; fields after its final ')' start
  // at field3. Never compare a reused PID without the kernel start tick.
  const end = value.lastIndexOf(')');
  const fields = value.slice(end + 2).split(/\s+/);
  if (end < 0 || !/^\d+$/.test(fields[19] || '')) throw new Error('Invalid process identity');
  return { state: fields[0], startTicks: fields[19] };
}
let hostPromise = null;
/** One random id per installation, kept where the database lives. */
async function persistedHost(directories) {
  for (const directory of directories) {
    const filename = path.join(directory, 'media-host-id');
    try {
      await fs.mkdir(directory, { recursive: true });
      try { await fs.writeFile(filename, crypto.randomBytes(16).toString('hex'), { flag: 'wx', mode: 0o600 }); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
      const value = await read(filename);
      if (/^[a-f0-9]{32}$/.test(value)) return { value, filename };
    } catch (_) { /* Read-only or missing: try the next place. */ }
  }
  return null;
}
/**
 * Who "this host" is, for telling a crashed worker of ours from a worker on
 * another machine: MEDIA_PROCESS_HOST_ID, else /etc/machine-id, else an id
 * generated once and persisted in the data directory (the Docker images
 * have no machine-id). `host` is null only when none of those is available.
 */
function hostIdentity(directories) {
  if (hostPromise && !directories) return hostPromise;
  const result = (async () => {
    const configured = process.env.MEDIA_PROCESS_HOST_ID;
    let ignored = '';
    if (configured) {
      if (/^[A-Za-z0-9._-]{16,128}$/.test(configured)) return { host: digest(configured), source: 'MEDIA_PROCESS_HOST_ID' };
      ignored = 'MEDIA_PROCESS_HOST_ID ignored: it must be 16-128 characters of A-Z a-z 0-9 . _ -; ';
    }
    for (const file of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
      try { const value = await read(file); if (/^[a-fA-F0-9]{32}$/.test(value)) return { host: digest(value.toLowerCase()), source: file, detail: ignored || undefined }; }
      catch (_) { /* Not present in most containers. */ }
    }
    const { DATA_DIRECTORY } = require('./mediaCapabilities');
    const persisted = await persistedHost(directories || [DATA_DIRECTORY, require('../config/storage').getStoragePath()]);
    if (persisted) return { host: digest(persisted.value), source: 'generated', detail: `${ignored}${persisted.filename}` };
    return { host: null, source: 'none', detail: `${ignored}no machine-id and the data directory is not writable; set MEDIA_PROCESS_HOST_ID. Interrupted work is recovered by age` };
  })();
  if (!directories) hostPromise = result;
  return result;
}
async function currentIdentity() {
  if (process.platform !== 'linux') return null;
  const { host } = await hostIdentity();
  try {
    const bootId = await read('/proc/sys/kernel/random/boot_id');
    const pidNamespace = await fs.readlink('/proc/self/ns/pid');
    const { startTicks } = parseStat(await read(`/proc/${process.pid}/stat`));
    if (!/^[a-f0-9-]{36}$/i.test(bootId) || !/^pid:\[\d+\]$/.test(pidNamespace)) return null;
    return { host, bootId, pidNamespace, pid: process.pid, startTicks };
  } catch (_) { return null; }
}
async function proveTermination(identity) {
  const current = await currentIdentity();
  if (!identity?.host || !current?.host || current.host !== identity.host || !/^[a-f0-9-]{36}$/i.test(identity.bootId || '')) return 'unknown';
  if (current.bootId !== identity.bootId) return 'dead';
  if (current.pidNamespace !== identity.pidNamespace) return 'unknown';
  if (!Number.isSafeInteger(identity.pid) || identity.pid <= 0 || !/^\d+$/.test(identity.startTicks || '')) return 'unknown';
  try {
    const actual = parseStat(await read(`/proc/${identity.pid}/stat`));
    if (actual.startTicks !== identity.startTicks || ['Z', 'X'].includes(actual.state)) return 'dead';
    return 'alive';
  } catch (error) { return error.code === 'ENOENT' || error.code === 'ESRCH' ? 'dead' : 'unknown'; }
}
module.exports = { currentIdentity, hostIdentity, proveTermination, parseStat,
  // Tests only.
  reset: () => { hostPromise = null; } };
