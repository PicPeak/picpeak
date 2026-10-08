const fs = require('fs').promises;
const crypto = require('crypto');

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
async function currentIdentity() {
  if (process.platform !== 'linux') return null;
  let host = null;
  const configured = process.env.MEDIA_PROCESS_HOST_ID;
  if (configured !== undefined) {
    if (!/^[A-Za-z0-9._-]{16,128}$/.test(configured)) throw new Error('Invalid MEDIA_PROCESS_HOST_ID');
    host = digest(configured);
  } else {
    for (const file of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
      try { const value = await read(file); if (/^[a-fA-F0-9]{32}$/.test(value)) { host = digest(value.toLowerCase()); break; } }
      catch (_) { /* No authoritative host identity: recovery stays fenced. */ }
    }
  }
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
module.exports = { currentIdentity, proveTermination, parseStat };
