/**
 * Resolve the Express trust-proxy setting without granting implicit trust to
 * private address ranges. An untrusted client can be on a private range too,
 * so deployments must name the proxy boundary they actually control.
 *
 * Express accepts booleans, hop counts, subnet names, CIDRs, and comma lists.
 * Environment variables arrive as strings, so convert the two booleans and
 * numeric hop counts while preserving every explicit subnet/list verbatim.
 */
function parseTrustProxy(value = process.env.TRUST_PROXY) {
  const raw = typeof value === 'string' ? value.trim() : value;
  const normalized = typeof raw === 'string' ? raw.toLowerCase() : raw;

  if (raw === undefined || raw === null || raw === '' || raw === false || normalized === 'false') {
    return false;
  }
  if (raw === true || normalized === 'true') return true;
  if (typeof raw === 'string' && /^\d+$/.test(raw)) return Number(raw);

  return raw;
}

/**
 * Native production installs are local-proxy-only by default. Development and
 * tests retain their existing all-interface behavior; container images set an
 * explicit 0.0.0.0 because the host publication is their security boundary.
 */
function resolveListenHost({
  value = process.env.LISTEN_HOST,
  nodeEnv = process.env.NODE_ENV,
} = {}) {
  if (typeof value === 'string' && value.trim()) return value.trim();
  return nodeEnv === 'production' ? '127.0.0.1' : '0.0.0.0';
}

module.exports = {
  parseTrustProxy,
  resolveListenHost,
};
