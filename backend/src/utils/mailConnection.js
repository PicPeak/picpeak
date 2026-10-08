const dns = require('dns').promises;
const net = require('net');
const { domainToASCII } = require('url');
const ipaddr = require('ipaddr.js');
const { isPrivateIP } = require('./networkValidation');
const logger = require('./logger');

function policyError(message, code = 'MAIL_HOST_FORBIDDEN') {
  const error = new Error(message);
  error.code = code;
  return error;
}

function hostname(value) {
  if (typeof value !== 'string' || !value || value.length > 253 || value.includes('%')) {
    throw policyError('Invalid mail hostname', 'MAIL_CONFIG_INVALID');
  }
  const bare = value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value;
  if (bare !== value && !net.isIPv6(bare)) throw policyError('Invalid mail hostname', 'MAIL_CONFIG_INVALID');
  if (net.isIP(bare)) return ipaddr.parse(bare).toString();
  if (/[\s/@\\?#:[\]]/.test(value) || [...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) {
    throw policyError('Invalid mail hostname', 'MAIL_CONFIG_INVALID');
  }
  const host = domainToASCII(value.toLowerCase().replace(/\.$/, ''));
  // Underscores are not valid in public DNS but are in compose service names.
  if (!host || host.length > 253 || !host.split('.').every(label => /^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?$/.test(label))) {
    throw policyError('Invalid mail hostname', 'MAIL_CONFIG_INVALID');
  }
  return host;
}

function endpoint(protocol, host, value) {
  const port = Number(value);
  if (!['smtp', 'imap'].includes(protocol) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw policyError('Invalid mail port or protocol', 'MAIL_CONFIG_INVALID');
  }
  return `${protocol}://${net.isIPv6(host) ? `[${host}]` : host}:${port}`;
}

// Deployment-owned approvals, never accepted from a settings row or request.
// Bind the exception to one protocol, canonical host and explicit port.
// Parsed once per environment value. A malformed entry approves nothing and is
// logged once; it must not refuse mail to every other host.
let approvals = { key: null, endpoints: new Set() };
function privateEndpoints() {
  const key = [process.env.MAIL_PRIVATE_ENDPOINTS, process.env.SMTP_HOST, process.env.SMTP_PORT].join('\n');
  if (key === approvals.key) return approvals.endpoints;
  const endpoints = new Set();
  for (const value of (process.env.MAIL_PRIVATE_ENDPOINTS || '').split(',').map(entry => entry.trim()).filter(Boolean)) {
    try {
      const url = new URL(value);
      if (url.username || url.password || (url.pathname && url.pathname !== '/') || url.search || url.hash || !url.port) {
        throw policyError('MAIL_PRIVATE_ENDPOINTS requires mail endpoints with an explicit port and no credentials/path', 'MAIL_CONFIG_INVALID');
      }
      endpoints.add(endpoint(url.protocol.slice(0, -1), hostname(url.hostname), url.port));
    } catch {
      logger.error(`Ignoring invalid MAIL_PRIVATE_ENDPOINTS entry "${value.replace(/\/\/[^/@]*@/, '//***@')}": expected smtp://host:port or imap://host:port without credentials or path`);
    }
  }
  // SMTP_HOST/SMTP_PORT in the deployment environment (what the first migration
  // seeds the SMTP row from) is the operator's own choice of server, so that
  // exact endpoint needs no second approval. Same default port as the seed.
  if (process.env.SMTP_HOST) {
    try {
      endpoints.add(endpoint('smtp', hostname(process.env.SMTP_HOST), process.env.SMTP_PORT || 1025));
    } catch { /* not a usable mail endpoint: approves nothing */ }
  }
  approvals = { key, endpoints };
  return endpoints;
}

// ipaddr.js files deprecated site-local addresses under plain unicast.
const SITE_LOCAL = ipaddr.parseCIDR('fec0::/10');

function assertAddress(address, allowPrivate) {
  if (typeof address !== 'string' || !net.isIP(address) || address.includes('%')) throw policyError('Invalid mail destination address');
  const parsed = ipaddr.process(address);
  // AWS and Google IPv6 metadata endpoints are ULA and Alibaba's is in the
  // CGNAT block, not link-local. Never except them.
  if (['fd00:ec2::254', 'fd20:ce::254', '100.100.100.200'].includes(parsed.toString())) throw policyError('Mail instance metadata destinations are forbidden');
  const range = parsed.kind() === 'ipv6' && parsed.match(SITE_LOCAL) ? 'private' : parsed.range();
  if (range === 'unicast' && !isPrivateIP(address)) return;
  // carrierGradeNat is where Tailscale and similar overlays put a relay.
  if (allowPrivate && ['private', 'loopback', 'uniqueLocal', 'carrierGradeNat'].includes(range)) return;
  throw policyError('Mail host resolves to a forbidden address; private mail servers require an exact MAIL_PRIVATE_ENDPOINTS approval');
}

function mailSocketOptions(protocol, value, port) {
  const host = hostname(value);
  const allowPrivate = privateEndpoints().has(endpoint(protocol, host, port));
  if (['metadata.google.internal', 'metadata.google'].includes(host) || (isPrivateIP(host) && !allowPrivate)) {
    throw policyError('Mail host is a private or forbidden destination');
  }
  // Numeric literals bypass Node's lookup hook, so check them before opening.
  if (net.isIP(host)) assertAddress(host, allowPrivate);
  const lookup = (name, options, callback) => {
    if (typeof options === 'function') { callback = options; options = {}; }
    if (name !== host) { callback(policyError('Mail connection destination changed')); return; }
    const family = typeof options === 'number' ? options : options?.family;
    if (family && family !== 4 && family !== 6) { callback(policyError('Invalid mail address family')); return; }
    let completed = false;
    const finish = (...args) => { if (completed) return; completed = true; clearTimeout(timer); callback(...args); };
    const timer = setTimeout(() => finish(policyError('Mail DNS lookup timed out', 'ETIMEDOUT')), 30000);
    timer.unref?.();
    dns.lookup(host, { all: true }).then(records => {
      if (!Array.isArray(records) || !records.length) throw policyError('Mail host could not be resolved', 'ENOTFOUND');
      // Validate the entire answer, not only the requested/first family.
      for (const record of records) {
        if (!record || net.isIP(record.address) !== record.family) throw policyError('Invalid mail destination address');
        assertAddress(record.address, allowPrivate);
      }
      const approved = records.filter(record => !family || record.family === family)
        .map(({ address, family: resolvedFamily }) => ({ address, family: resolvedFamily }));
      if (!approved.length) throw policyError('No mail address for the requested family', 'ENOTFOUND');
      if (options?.all) finish(null, approved);
      else finish(null, approved[0].address, approved[0].family);
    }).catch(error => finish(error));
  };
  // host also binds STARTTLS verification for a socket whose peer is a literal.
  return { host, servername: net.isIP(host) ? undefined : host, lookup };
}

// Preflight for the admin routes: null when the host may be used, otherwise
// the 400 body. A name that does not resolve is a typo rather than a policy
// refusal and says so; a private and a forbidden destination stay one answer.
async function mailHostRejection(protocol, host, port) {
  try {
    const policy = mailSocketOptions(protocol, host, port);
    if (!net.isIP(policy.host)) await new Promise((resolve, reject) => policy.lookup(policy.host, { all: true }, error => error ? reject(error) : resolve()));
    return null;
  } catch (error) {
    const label = String(protocol).toUpperCase();
    if (['ENOTFOUND', 'EAI_AGAIN'].includes(error.code)) {
      return { error: `${label} host could not be resolved. Check the hostname.`, code: 'MAIL_HOST_UNRESOLVED' };
    }
    return { error: `${label} host cannot point to a private or internal network address without deployment approval`, code: 'MAIL_HOST_FORBIDDEN' };
  }
}

/** Nodemailer ignores ordinary lookup options. Supply a connected raw socket;
 * it performs implicit TLS/STARTTLS on that socket with the original identity.
 * This hook runs for verify and every new send/pool connection, not just setup.
 */
function smtpConnectionOptions(options) {
  const host = hostname(options.host);
  const port = Number(options.port) || (options.secure ? 465 : 587);
  const getSocket = (_options, callback) => {
    let socket; let timer; let completed = false;
    const finish = error => {
      if (completed) return;
      completed = true; clearTimeout(timer);
      socket?.removeListener('connect', connected); socket?.removeListener('error', finish); socket?.removeListener('close', closed);
      if (error) { socket?.destroy(); callback(error); }
      else callback(null, { connection: socket });
    };
    const connected = () => finish();
    const closed = () => finish(policyError('Mail connection closed before establishment', 'ECONNECTION'));
    try {
      const policy = mailSocketOptions('smtp', host, port);
      socket = net.createConnection({ host, port, lookup: policy.lookup, autoSelectFamily: true });
      socket.once('connect', connected); socket.once('error', finish); socket.once('close', closed);
      timer = setTimeout(() => finish(policyError('Mail connection timed out', 'ETIMEDOUT')), options.connectionTimeout || 120000);
      timer.unref?.();
    } catch (error) { finish(error); }
  };
  return { ...options, host, port, servername: net.isIP(host) ? undefined : host,
    tls: { ...options.tls, host, servername: net.isIP(host) ? undefined : host }, getSocket };
}

module.exports = { mailSocketOptions, smtpConnectionOptions, mailHostRejection };
