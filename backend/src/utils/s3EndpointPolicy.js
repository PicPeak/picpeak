/**
 * Who a backup S3 client may connect to (issue 1641).
 *
 * Public endpoints are always allowed. A private one (RFC1918, loopback, IPv6
 * unique-local) is denied unless a Super Admin approved that exact origin,
 * stored as backup_s3_private_endpoint_approval. Link-local, cloud-metadata,
 * CGNAT and reserved destinations can never be approved.
 *
 * The decision is made twice: once up front, so a save or a connection test
 * can answer with a stable error code, and again inside the socket lookup of
 * every connection the S3 client opens. The second one is what holds against
 * DNS rebinding — a hostname that answered with a public address at save time
 * cannot later steer a backup upload at an internal one.
 *
 * Production only, like the checks this replaces: development points at a
 * localhost MinIO deliberately.
 */
const http = require('http');
const https = require('https');
const dns = require('dns').promises;
const net = require('net');
const ipaddr = require('ipaddr.js');
const { isPrivateIP } = require('./networkValidation');

const APPROVAL_SETTING = 'backup_s3_private_endpoint_approval';
const METADATA_HOSTS = new Set(['metadata.google.internal', 'metadata.google', 'metadata']);
const APPROVABLE_RANGES = new Set(['private', 'loopback', 'uniqueLocal']);

class S3EndpointError extends Error {
  constructor(code, message, details = {}) {
    // The code leads the message so it survives being stored as a backup
    // run's error_message and wrapped by testConnection's prefix.
    super(`${code}: ${message}`);
    this.code = code;
    this.severity = code === 'S3_PRIVATE_ENDPOINT' ? 'warning' : 'error';
    Object.assign(this, details);
  }
}

const policyApplies = () => process.env.NODE_ENV === 'production';

/** The endpoint as the S3 client will reach it: scheme + host + port. */
function endpointOrigin(endpoint, sslEnabled = true) {
  if (!endpoint || typeof endpoint !== 'string') return null;
  const trimmed = endpoint.trim();
  const withProto = /^https?:\/\//i.test(trimmed) ? trimmed : `${sslEnabled === false ? 'http' : 'https'}://${trimmed}`;
  try {
    const url = new URL(withProto);
    if (url.username || url.password) return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** 'public', 'approvable' or 'forbidden' for one resolved address. */
function classifyAddress(address) {
  let parsed;
  try { parsed = ipaddr.process(address); } catch { return 'forbidden'; }
  const range = parsed.range();
  if (range === 'unicast' && !isPrivateIP(parsed.toString())) return 'public';
  return APPROVABLE_RANGES.has(range) ? 'approvable' : 'forbidden';
}

/** The strictest class across all answers: one forbidden answer forbids. */
function classifyAddresses(addresses) {
  const classes = addresses.map(classifyAddress);
  if (classes.includes('forbidden')) return 'forbidden';
  if (classes.includes('approvable')) return 'approvable';
  return 'public';
}

const bareHost = (hostname) => hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');

/**
 * Resolve and classify an endpoint.
 * @returns {Promise<{status: 'public'|'approvable'|'forbidden'|'unresolved'|'invalid', origin: string|null}>}
 */
async function classifyS3Endpoint(endpoint, sslEnabled = true) {
  const origin = endpointOrigin(endpoint, sslEnabled);
  if (!origin) return { status: 'invalid', origin: null };
  const host = bareHost(new URL(origin).hostname);
  if (METADATA_HOSTS.has(host)) return { status: 'forbidden', origin };
  if (net.isIP(host)) return { status: classifyAddresses([host]), origin };
  let answers;
  try { answers = await dns.lookup(host, { all: true }); } catch { return { status: 'unresolved', origin }; }
  if (!answers.length) return { status: 'unresolved', origin };
  const status = classifyAddresses(answers.map((a) => a.address));
  // localhost, *.internal, *.local: internal by name even when some resolver
  // answers publicly, as isHostAllowed has always treated them.
  if (status === 'public' && isPrivateIP(host)) return { status: 'approvable', origin };
  return { status, origin };
}

/**
 * The synchronous part of the policy, for the S3 client constructor: decide
 * what can be decided without DNS (IP literals and internal names). Hostnames
 * are left to the connection-time lookup in s3EndpointAgents.
 */
function assertLiteralEndpointAllowed(endpoint, { sslEnabled = true, allowPrivate = false } = {}) {
  if (!policyApplies() || !endpoint) return;
  const origin = endpointOrigin(endpoint, sslEnabled);
  if (!origin) throw new S3EndpointError('S3_ENDPOINT_INVALID', 'S3 endpoint is not a valid URL');
  const host = bareHost(new URL(origin).hostname);
  let status = null;
  if (METADATA_HOSTS.has(host)) status = 'forbidden';
  else if (net.isIP(host)) status = classifyAddresses([host]);
  else if (isPrivateIP(host)) status = 'approvable';
  if (status === 'forbidden') {
    throw new S3EndpointError('S3_ENDPOINT_FORBIDDEN',
      'S3 endpoint is a link-local, metadata or reserved address, which can never be approved', { origin });
  }
  if (status === 'approvable' && !allowPrivate) {
    throw new S3EndpointError('S3_PRIVATE_ENDPOINT',
      'S3 endpoint is a private or internal network address and has not been approved', { origin });
  }
}

/** True when the backup settings approve exactly this endpoint's origin. */
function isPrivateEndpointApproved(endpoint, sslEnabled, approval) {
  const origin = endpointOrigin(endpoint, sslEnabled);
  return Boolean(origin && typeof approval === 'string' && approval.trim() === origin);
}

/**
 * backup_s3_ssl_enabled as a backup run reads it (backupService
 * normalizeBoolean), defaulting to on when unset — the approval origin and
 * the scheme a client connects with must never disagree.
 */
function backupS3Ssl(config) {
  const value = config ? config.backup_s3_ssl_enabled : undefined;
  if (value === undefined || value === null) return true;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const trimmed = value.trim().toLowerCase();
    if (trimmed === 'true') return true;
    if (trimmed === 'false') return false;
  }
  return Boolean(value);
}

/** The allowPrivateEndpoint flag for an S3 client built from backup settings. */
function backupS3Access(config) {
  if (!config) return { allowPrivateEndpoint: false };
  const sslEnabled = backupS3Ssl(config);
  return {
    allowPrivateEndpoint: isPrivateEndpointApproved(config.backup_s3_endpoint, sslEnabled, config[APPROVAL_SETTING]),
  };
}

/**
 * Throws an S3EndpointError unless the endpoint may be used. A no-op outside
 * production and when no custom endpoint is set (AWS itself).
 */
async function assertS3EndpointAllowed(endpoint, { sslEnabled = true, allowPrivate = false } = {}) {
  if (!policyApplies() || !endpoint) return;
  const { status, origin } = await classifyS3Endpoint(endpoint, sslEnabled);
  if (status === 'public') return;
  if (status === 'approvable') {
    if (allowPrivate) return;
    throw new S3EndpointError('S3_PRIVATE_ENDPOINT',
      'S3 endpoint resolves to a private or internal network address and has not been approved', { origin });
  }
  if (status === 'unresolved') {
    throw new S3EndpointError('S3_ENDPOINT_UNRESOLVED', 'S3 endpoint hostname could not be resolved', { origin });
  }
  if (status === 'invalid') {
    throw new S3EndpointError('S3_ENDPOINT_INVALID', 'S3 endpoint is not a valid URL', { origin });
  }
  throw new S3EndpointError('S3_ENDPOINT_FORBIDDEN',
    'S3 endpoint resolves to a link-local, metadata or reserved address, which can never be approved', { origin });
}

/**
 * http/https agents whose lookup re-validates every DNS answer at connection
 * time. The SDK connects through these, so a rebinding answer fails the
 * socket instead of reaching an internal address.
 */
function s3EndpointAgents(endpoint, { sslEnabled = true, allowPrivate = false } = {}) {
  const origin = endpointOrigin(endpoint, sslEnabled);
  if (!origin) throw new S3EndpointError('S3_ENDPOINT_INVALID', 'S3 endpoint is not a valid URL');
  const expectedHost = bareHost(new URL(origin).hostname);
  const lookup = (name, options, callback) => {
    if (typeof options === 'function') { callback = options; options = {}; }
    if (bareHost(name) !== expectedHost) {
      return callback(new S3EndpointError('S3_ENDPOINT_FORBIDDEN', 'S3 destination changed'));
    }
    const family = typeof options === 'number' ? options : options?.family;
    const answer = net.isIP(expectedHost)
      ? Promise.resolve([{ address: expectedHost, family: net.isIP(expectedHost) }])
      : dns.lookup(expectedHost, { all: true });
    answer.then((addresses) => {
      if (!addresses.length) throw new S3EndpointError('S3_ENDPOINT_UNRESOLVED', 'S3 endpoint hostname could not be resolved');
      const status = classifyAddresses(addresses.map((a) => a.address));
      if (status === 'forbidden' || (status === 'approvable' && !allowPrivate)) {
        throw new S3EndpointError(status === 'forbidden' ? 'S3_ENDPOINT_FORBIDDEN' : 'S3_PRIVATE_ENDPOINT',
          'S3 endpoint resolved to a destination that is not permitted');
      }
      const matches = family ? addresses.filter((a) => a.family === family) : addresses;
      if (!matches.length) throw new S3EndpointError('S3_ENDPOINT_UNRESOLVED', 'No permitted S3 address for the requested family');
      if (options?.all) callback(null, matches);
      else callback(null, matches[0].address, matches[0].family);
    }).catch(callback);
  };
  return {
    // keepAlive and maxSockets as the SDK's own default agents; a reused
    // socket keeps the address that was vetted when it was opened.
    httpAgent: new http.Agent({ lookup, keepAlive: true, maxSockets: 50 }),
    httpsAgent: new https.Agent({ lookup, keepAlive: true, maxSockets: 50 }),
  };
}

module.exports = {
  APPROVAL_SETTING,
  S3EndpointError,
  endpointOrigin,
  classifyAddress,
  classifyS3Endpoint,
  isPrivateEndpointApproved,
  backupS3Access,
  backupS3Ssl,
  assertS3EndpointAllowed,
  assertLiteralEndpointAllowed,
  s3EndpointAgents,
  policyApplies,
};
