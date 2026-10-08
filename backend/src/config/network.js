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
  isTrustProxyUnset,
  parseTrustProxy,
  resolveListenHost,
};
