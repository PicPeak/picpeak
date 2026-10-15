const ipaddr = require('ipaddr.js');

// What an unset TRUST_PROXY has always meant. Kept so an install that only
// pulls a new image (old compose file, native install behind nginx/Caddy)
// still resolves the real client address behind its private-range proxy.
const LEGACY_TRUST_PROXY = 'loopback, linklocal, uniquelocal';

function isTrustProxyUnset(value = process.env.TRUST_PROXY) {
  return value === undefined || value === null
    || (typeof value === 'string' && value.trim() === '');
}

/**
 * Resolve the Express trust-proxy setting.
 *
 * Unset keeps the legacy private-range trust (compatibility). That is wider
 * than it should be: an untrusted client can sit on a private range too, so
 * deployments should name the proxy boundary they actually control, ideally
 * as an exact hop count. An explicit false/0 trusts no forwarding headers.
 *
 * Express accepts booleans, hop counts, subnet names, CIDRs, and comma lists.
 * Environment variables arrive as strings, so convert the two booleans and
 * numeric hop counts while preserving every explicit subnet/list verbatim.
 */
function parseTrustProxy(value = process.env.TRUST_PROXY) {
  if (isTrustProxyUnset(value)) return LEGACY_TRUST_PROXY;

  const raw = typeof value === 'string' ? value.trim() : value;
  const normalized = typeof raw === 'string' ? raw.toLowerCase() : raw;

  if (raw === false || normalized === 'false') return false;
  if (raw === true || normalized === 'true') return true;
  if (typeof raw === 'string' && /^\d+$/.test(raw)) return Number(raw);

  return raw;
}

const PROXY_HOP_RANGES = new Set(['private', 'loopback', 'linkLocal', 'uniqueLocal']);

// The hop as a canonical address without an IPv6 zone (the zone is free
// text from the header), or null when it is not a private-range address.
function privateHop(address) {
  try {
    const parsed = ipaddr.process(address);
    if (!PROXY_HOP_RANGES.has(parsed.range())) return null;
    if (parsed.zoneId) parsed.zoneId = undefined;
    return parsed.toString();
  } catch {
    return null;
  }
}

/**
 * Middleware that logs once per process when TRUST_PROXY is one hop but
 * another proxy sits in front of the bundled nginx. nginx appends the address
 * it saw, so with one trusted hop req.ip is that address. When it is private
 * and the header carries an earlier entry, something on a private network
 * probably forwarded the request to nginx: every client then shares that
 * proxy's address. The earlier entry can also be sent by a LAN client that
 * reaches nginx directly, so the message is conditional: raising the hop
 * count for such a client would let it choose its own address. Behaviour is
 * unchanged; only the private hop is logged.
 */
function createProxyChainWarning({ trustProxy, logger }) {
  let warned = trustProxy !== 1;
  return function proxyChainWarning(req, res, next) {
    if (!warned) {
      const header = req.headers['x-forwarded-for'];
      const hops = typeof header === 'string'
        ? header.split(',').map((hop) => hop.trim()).filter(Boolean)
        : [];
      const nginxPeer = hops.length >= 2 ? privateHop(hops[hops.length - 1]) : null;
      if (nginxPeer) {
        warned = true;
        logger.warn(
          `A request reached the bundled nginx from ${nginxPeer} with a forwarded client address. `
          + 'If another reverse proxy forwards to nginx, all clients share that proxy\'s address '
          + 'for rate limits: set TRUST_PROXY=2 (see README upgrade note). Leave TRUST_PROXY=1 '
          + 'if clients can reach nginx directly, or they can choose their own address.'
        );
      }
    }
    next();
  };
}

/**
 * Honour an explicit LISTEN_HOST. Unset returns undefined, which leaves the
 * host out of `listen()` so Node binds every interface as it always has
 * (dual-stack where IPv6 is available): a reverse proxy on another host or
 * container, and a `localhost` health probe, keep reaching the process.
 */
function resolveListenHost({ value = process.env.LISTEN_HOST } = {}) {
  if (typeof value === 'string' && value.trim()) return value.trim();
  return undefined;
}

module.exports = {
  LEGACY_TRUST_PROXY,
  createProxyChainWarning,
  isTrustProxyUnset,
  parseTrustProxy,
  resolveListenHost,
};
