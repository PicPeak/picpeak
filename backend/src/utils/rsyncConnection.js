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

function hostKeyOptions(key) {
  const options = ['-o', 'StrictHostKeyChecking=yes', '-o', 'CheckHostIP=no',
    '-o', 'VerifyHostKeyDNS=no', '-o', 'UpdateHostKeys=no'];
  const knownHosts = process.env.BACKUP_SSH_KNOWN_HOSTS || (key && path.join(path.dirname(key), 'known_hosts'));
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
async function resolveRsyncConnection({ host: value, user: username, sshKey: keyValue }) {
  const host = validateHost(value);
  const user = validateUser(username);
  const key = validateKey(keyValue);
  const trustOptions = hostKeyOptions(key);
  const result = await resolveHost(host);
  if (result.reason === 'unresolved') {
    throw new RsyncConnectionError('RSYNC_HOST_UNRESOLVED', 'Rsync host could not be resolved');
  }
  const approved = result.reason === 'ok' && Array.isArray(result.addresses) && result.addresses.length > 0
    && result.addresses.every(record => record && isPublicAddress(record.address) && net.isIP(record.address) === record.family);
  if (!approved) {
    throw new RsyncConnectionError('RSYNC_HOST_FORBIDDEN', 'Host cannot be a private, internal or reserved network address');
  }
  const addresses = [...new Set(result.addresses.map(record => record.address))];
  const address = addresses[0];
  // Preserve native SSH's pre-connect fallback without a second DNS lookup.
  // The application-owned relay consumes only this immutable literal set and
  // never retries once a socket is established or SSH/rsync has begun work.
  const proxy = addresses.length > 1
    ? [process.execPath, path.join(__dirname, 'rsyncProxy.js'), ...addresses].map(shellQuote).join(' ')
    : 'none';
  // Ignore local/system SSH aliases, proxies, canonicalization and control
  // sockets. Otherwise they can redirect even a vetted literal destination.
  const sshArgs = ['-F', '/dev/null', '-o', `Hostname=${address}`, '-o', `HostKeyAlias=${host}`,
    '-o', 'CanonicalizeHostname=no', '-o', `ProxyCommand=${proxy}`, '-o', 'ProxyJump=none',
    '-o', 'ControlMaster=no', '-o', 'ControlPath=none', '-o', 'BatchMode=yes', '-o', `ConnectTimeout=${10 * addresses.length}`,
    ...trustOptions];
  if (key) sshArgs.push('-i', key);
  const rsyncHost = net.isIPv6(host) ? `[${host}]` : host;
  return { host, address, addresses, target: user ? `${user}@${host}` : host,
    rsyncTarget: user ? `${user}@${rsyncHost}` : rsyncHost, sshArgs,
    rsyncShell: ['ssh', ...sshArgs].map(rsyncQuote).join(' ') };
}

module.exports = { resolveRsyncConnection, isPublicAddress };
