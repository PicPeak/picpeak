const fs = require('fs');
const path = require('path');
const net = require('net');
const ipaddr = require('ipaddr.js');
const { resolveHost, isPrivateIP } = require('./networkValidation');

class RsyncConnectionError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.code = code;
  }
}

function invalid(message) {
  throw new RsyncConnectionError('RSYNC_CONFIG_INVALID', message);
}

function validateHost(value) {
  if (typeof value !== 'string' || !value || value.length > 253) invalid('Invalid rsync host format');
  const lower = value.toLowerCase();
  const host = lower.includes(':') ? lower : lower.replace(/\.$/, '');
  // Brackets are accepted only around a complete IPv6 literal, never as
  // rsync/SSH syntax. Zone identifiers are deliberately not supported.
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  if ((bare !== host && !net.isIPv6(bare)) || bare.includes('%')) invalid('Invalid rsync host format');
  if (net.isIP(bare) && !bare.includes('%')) return bare;
  if (!host.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
    invalid('Invalid rsync host format');
  }
  return host;
}

function validateUser(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || value.length > 255 || !/^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(value)) {
    invalid('Invalid rsync username format');
  }
  return value;
}

// A whole number only: the value reaches ssh, the relay and known_hosts.
function validatePort(value) {
  if (value == null || value === '') return 22;
  const port = typeof value === 'string' && /^[0-9]{1,5}$/.test(value) ? Number(value) : value;
  if (!Number.isInteger(port) || port < 1 || port > 65535) invalid('Invalid rsync SSH port: a whole number from 1 to 65535 is required');
  return port;
}

function filePath(value, label) {
  if (typeof value !== 'string' || value.length > 1024 || !path.isAbsolute(value) || !/^[a-zA-Z0-9._/@:-]+$/.test(value)) {
    invalid(`Invalid ${label}: an absolute file path without spaces or shell syntax is required`);
  }
  return value;
}

function validateKey(value) {
  if (value == null || value === '') return null;
  if (/PRIVATE KEY|\n/.test(String(value))) {
    invalid('The rsync SSH key setting holds a pasted key, not a key file path. Enter the absolute path to a private key file.');
  }
  const key = filePath(value, 'SSH key path');
  try { if (fs.statSync(key).isFile()) return key; } catch { /* stable error below */ }
  invalid('SSH key file not found');
}

/** The selected trust file: BACKUP_SSH_KNOWN_HOSTS, else known_hosts beside the key. */
const knownHostsPath = key => process.env.BACKUP_SSH_KNOWN_HOSTS || (key && path.join(path.dirname(key), 'known_hosts')) || null;

// The name a known_hosts line must carry, as OpenSSH and ssh-keyscan write
// it: the bare lower-case host on port 22, "[host]:port" on any other.
const hostKeyAlias = (host, port) => (port === 22 ? host : `[${host}]:${port}`);

function hostKeyOptions(key) {
  const options = ['-o', 'StrictHostKeyChecking=yes', '-o', 'CheckHostIP=no',
    '-o', 'VerifyHostKeyDNS=no', '-o', 'UpdateHostKeys=no'];
  const knownHosts = knownHostsPath(key);
  if (knownHosts) {
    const trust = filePath(knownHosts, 'BACKUP_SSH_KNOWN_HOSTS');
    try {
      if (!fs.statSync(trust).isFile()) throw new Error('not a file');
      fs.accessSync(trust, fs.constants.R_OK);
    } catch {
      throw new RsyncConnectionError('RSYNC_SSH_TRUST_REQUIRED',
        'Provision a readable known_hosts file with the independently verified destination host key; set BACKUP_SSH_KNOWN_HOSTS to its absolute path');
    }
    options.push('-o', `UserKnownHostsFile=${trust}`, '-o', 'GlobalKnownHostsFile=/dev/null');
  }
  // Without a selected store, retain OpenSSH's pre-provisioned user/global
  // trust and default identities/agent. Strict yes never establishes TOFU.
  return options;
}

function isPublicAddress(address) {
  if (typeof address !== 'string' || !net.isIP(address) || address.includes('%') || isPrivateIP(address)) return false;
  try { return ipaddr.process(address).range() === 'unicast'; } catch { return false; }
}

// OpenSSH executes ProxyCommand with a shell. These are application-owned
// executable paths and already validated literals, never a configured command.
const shellQuote = value => '\'' + value.replace(/'/g, '\'\\\'\'') + '\'';
// rsync has its own -e parser: doubled quotes, not shell backslash escaping.
const rsyncQuote = value => '\'' + value.replace(/'/g, '\'\'') + '\'';

/** Resolve once, consume that result, and never let SSH re-resolve the name. */
async function resolveRsyncConnection({ host: value, user: username, sshKey: keyValue, port: portValue }) {
  const host = validateHost(value);
  const user = validateUser(username);
  const port = validatePort(portValue);
  const key = validateKey(keyValue);
  const result = await resolveHost(host);
  if (result.reason === 'unresolved') {
    throw new RsyncConnectionError('RSYNC_HOST_UNRESOLVED', 'Rsync host could not be resolved');
  }
  const approved = result.reason === 'ok' && Array.isArray(result.addresses) && result.addresses.length > 0
    && result.addresses.every(record => record && isPublicAddress(record.address) && net.isIP(record.address) === record.family);
  if (!approved) {
    throw new RsyncConnectionError('RSYNC_HOST_FORBIDDEN', 'Host cannot be a private, internal or reserved network address');
  }
  // After the address check: a forbidden host is reported as forbidden, not
  // as a missing trust file.
  const trustOptions = hostKeyOptions(key);
  const addresses = [...new Set(result.addresses.map(record => record.address))];
  const address = addresses[0];
  // Preserve native SSH's pre-connect fallback without a second DNS lookup.
  // The application-owned relay consumes only this immutable literal set and
  // never retries once a socket is established or SSH/rsync has begun work.
  const proxy = addresses.length > 1
    ? [process.execPath, path.join(__dirname, 'rsyncProxy.js'), String(port), ...addresses]
      .map(value => shellQuote(value.replace(/%/g, '%%'))).join(' ')
    : 'none';
  // Ignore local/system SSH aliases, proxies, canonicalization and control
  // sockets. Otherwise they can redirect even a vetted literal destination.
  const sshArgs = ['-F', '/dev/null', '-p', String(port), '-o', `Hostname=${address}`,
    '-o', `HostKeyAlias=${hostKeyAlias(host, port)}`,
    '-o', 'CanonicalizeHostname=no', '-o', `ProxyCommand=${proxy}`, '-o', 'ProxyJump=none',
    '-o', 'ControlMaster=no', '-o', 'ControlPath=none', '-o', 'BatchMode=yes', '-o', `ConnectTimeout=${10 * addresses.length}`,
    ...trustOptions];
  if (key) sshArgs.push('-i', key);
  const rsyncHost = net.isIPv6(host) ? `[${host}]` : host;
  return { host, port, address, addresses, keyPath: key, knownHostsPath: knownHostsPath(key),
    target: user ? `${user}@${host}` : host,
    rsyncTarget: user ? `${user}@${rsyncHost}` : rsyncHost, sshArgs,
    rsyncShell: ['ssh', ...sshArgs].map(rsyncQuote).join(' ') };
}

const HOST_KEY_FAILURE = /REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed/;

/** The coded error for ssh/rsync output that reports a refused host key, else null. */
function hostKeyFailure(output) {
  if (!HOST_KEY_FAILURE.test(String(output || ''))) return null;
  return new RsyncConnectionError('RSYNC_SSH_HOST_KEY_UNTRUSTED',
    'The destination host key is unknown or changed. Independently verify it and provision the approved known_hosts entry before retrying.');
}

/**
 * A warning for an rsync destination whose selected trust file is missing,
 * else null. Releases before the pinned connection accepted any host key, so
 * an upgraded install has no such file and its next run is refused.
 */
function missingKnownHostsWarning(config) {
  if (!config || config.backup_destination_type !== 'rsync' || !config.backup_rsync_host) return null;
  let host; let port; let trust;
  try {
    host = validateHost(config.backup_rsync_host);
    port = validatePort(config.backup_rsync_port);
    trust = knownHostsPath(validateKey(config.backup_rsync_ssh_key));
    if (!trust || fs.statSync(filePath(trust, 'BACKUP_SSH_KNOWN_HOSTS')).isFile()) return null;
  } catch (error) {
    // A broken host, port or key is reported by the run itself.
    if (error instanceof RsyncConnectionError) return null;
  }
  return `Rsync backups to ${host} will fail with RSYNC_SSH_TRUST_REQUIRED: the SSH known_hosts file ${trust} does not exist. `
    + `Create it with "ssh-keyscan${port === 22 ? '' : ` -p ${port}`} ${host} >> ${trust}" and compare the key fingerprint with the server's own before trusting it. `
    + `The entry must be named ${hostKeyAlias(host, port)} exactly (lower case, no trailing dot).`;
}

/**
 * One rsync run, no shell; resolves with its outcome and never rejects.
 * `timeoutMs` 0 sets no wall-clock limit (a restore download: rsync's own
 * --timeout bounds a stalled transfer instead). `onStdoutLine` receives each
 * complete stdout line, for progress. Aborting `signal` stops the run
 * (SIGTERM); the outcome then carries `aborted: true`.
 */
function runRsync(args, { timeoutMs = module.exports.RSYNC_PROBE_TIMEOUT_MS, onStdoutLine, signal } = {}) {
  return new Promise((resolve) => {
    let child;
    let settled = false; let timedOut = false; let aborted = false; let timer;
    const stop = () => { aborted = true; if (child) child.kill('SIGTERM'); };
    const done = outcome => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', stop);
      resolve({ ...outcome, timedOut, ...(aborted ? { aborted } : {}) });
    };
    try {
      child = require('child_process').spawn('rsync', args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) { done({ error, stderr: '' }); return; }
    if (signal) {
      if (signal.aborted) stop();
      else signal.addEventListener('abort', stop);
    }
    // Our own timer, not spawn's `timeout`: rsync traps SIGTERM and exits
    // with code 20, so the close event alone cannot tell a timeout apart.
    if (timeoutMs > 0) timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, timeoutMs);
    let stderr = '';
    let pending = '';
    child.stdout.on('data', (data) => {
      if (!onStdoutLine) return;
      const lines = (pending + data).split('\n');
      pending = lines.pop();
      if (pending.length > 64 * 1024) pending = '';
      for (const line of lines) onStdoutLine(line);
    });
    child.stderr.on('data', (data) => { if (stderr.length < 64 * 1024) stderr += data; });
    child.on('error', error => done({ error, stderr }));
    child.on('close', (code, signal) => done({ code, signal, stderr }));
  });
}

// GNU rsync: `link_stat "/x" failed: No such file or directory (2)` (or
// change_dir); openrsync (macOS): `error: /x: (l)stat: No such file or directory`.
const PATH_NOT_FOUND = /(?:link_stat|change_dir)\b.*No such file or directory \(2\)|\(l\)stat: No such file or directory/;

/**
 * List the remote path with rsync itself, over the same -e transport a
 * backup run uses. Restricted hosts (Hetzner Storage Box, rrsync, forced
 * `command=` keys) accept that but refuse an arbitrary `ssh … echo`. A
 * missing final directory passes when its parent exists: rsync creates it on
 * the first backup, but not its parents.
 */
async function probeRsyncDestination(connection, remotePath) {
  const list = target => runRsync(['--list-only', '-e', connection.rsyncShell, `${connection.rsyncTarget}:${target}`]);
  const trimmed = remotePath.length > 1 ? remotePath.replace(/\/+$/, '') || '/' : remotePath;
  const first = await list(trimmed);
  if (first.code === 0) return { ok: true, exists: true };
  const parent = require('path').posix.dirname(trimmed);
  if (!PATH_NOT_FOUND.test(first.stderr) || parent === trimmed) return { ok: false, outcome: first };
  const second = await list(parent);
  if (second.code === 0) return { ok: true, exists: false };
  return { ok: false, outcome: second, parent };
}

// Lines that never leave the server, and local paths shown as placeholders.
function stderrExcerpt(stderr, connection) {
  const known = [[connection.keyPath, '<ssh key>'], [connection.knownHostsPath, '<known_hosts>'],
    [path.join(__dirname, 'rsyncProxy.js'), '<relay>'], [process.execPath, '<node>']]
    .filter(([value]) => value);
  let text = String(stderr || '').split(/\r?\n/)
    .filter(line => line.trim() && !/PRIVATE KEY|^[A-Za-z0-9+/=]{40,}$/.test(line.trim()))
    .join(' | ');
  for (const [value, label] of known) text = text.split(value).join(label);
  // eslint-disable-next-line no-control-regex
  text = text.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return text.length > 300 ? `…${text.slice(-300)}` : text;
}

/** A coded, actionable error for a failed rsync probe (see probeRsyncDestination). */
function rsyncProbeFailure(outcome, connection, { remotePath, parent } = {}) {
  const stderr = String(outcome.stderr || '');
  const detail = stderrExcerpt(stderr, connection);
  const fail = (code, message) => {
    const error = new RsyncConnectionError(code, message);
    error.detail = detail;
    return error;
  };
  if (outcome.error) {
    if (outcome.error.code === 'ENOENT') {
      return fail('RSYNC_BINARY_MISSING', 'The rsync program is not installed in the backend container. The image must include rsync and an SSH client (openssh-client).');
    }
    return fail('RSYNC_CONNECTION_FAILED', `Rsync could not be started: ${outcome.error.message}`);
  }
  if (/Failed to exec ssh|ssh: not found/.test(stderr)) {
    return fail('RSYNC_SSH_BINARY_MISSING', 'The ssh program is not installed in the backend container. rsync needs it to reach the destination; the image must include an SSH client (openssh-client).');
  }
  const hostKey = hostKeyFailure(stderr);
  if (hostKey) { hostKey.detail = detail; return hostKey; }
  if (/UNPROTECTED PRIVATE KEY FILE|Load key .*: (?:invalid format|bad permissions)/.test(stderr)) {
    return fail('RSYNC_SSH_KEY_UNUSABLE', 'ssh refused to use the configured key file: its permissions are too open (use 600) or it is not a valid private key.');
  }
  if (/Permission denied \((?:publickey|password|keyboard-interactive|gssapi|hostbased)|Too many authentication failures/.test(stderr)) {
    return fail('RSYNC_AUTH_FAILED', `The destination refused the SSH login${connection.target.includes('@') ? ` for ${connection.target.split('@')[0]}` : ''}. Check the user name and that the public half of the configured key is authorized on the destination.`);
  }
  if (/Connection refused/.test(stderr)) {
    return fail('RSYNC_CONNECTION_REFUSED', `Nothing accepts SSH connections on ${connection.host} port ${connection.port}. Check the host and port (a Hetzner Storage Box uses port 23).`);
  }
  if (outcome.timedOut || outcome.signal || /timed out/i.test(stderr)) {
    return fail('RSYNC_CONNECTION_TIMEOUT', `The connection to ${connection.host} port ${connection.port} timed out. Check the host, the port and any firewall in between.`);
  }
  if (/No route to host|Network is unreachable|No vetted SSH destination could be reached|Could not resolve hostname/.test(stderr)) {
    return fail('RSYNC_HOST_UNREACHABLE', `${connection.host} port ${connection.port} cannot be reached from the backend.`);
  }
  if (PATH_NOT_FOUND.test(stderr)) {
    return fail('RSYNC_REMOTE_PATH_NOT_FOUND', parent
      ? `Neither ${remotePath} nor its parent ${parent} exists on the destination. rsync creates only the last directory of the remote path; create the parent first.`
      : `The remote path ${remotePath} does not exist on the destination.`);
  }
  if (/failed: Permission denied \(13\)/.test(stderr)) {
    return fail('RSYNC_REMOTE_PATH_DENIED', `The destination denies access to ${remotePath}. Check its permissions for the SSH user.`);
  }
  const exit = outcome.code == null ? 'without an exit code' : `with code ${outcome.code}`;
  return fail('RSYNC_CONNECTION_FAILED', `Rsync connection failed (rsync exited ${exit})${detail ? `: ${detail}` : '.'}`);
}

module.exports = { resolveRsyncConnection, isPublicAddress, hostKeyFailure, missingKnownHostsWarning,
  probeRsyncDestination, rsyncProbeFailure, runRsync, PATH_NOT_FOUND, RsyncConnectionError,
  RSYNC_PROBE_TIMEOUT_MS: 15000 };
