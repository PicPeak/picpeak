const { URL } = require('url');
const net = require('net');

/**
 * Check if a hostname or IP resolves to a private/internal network address.
 * Blocks SSRF attempts targeting internal infrastructure.
 */
function isPrivateIP(hostname) {
  if (!hostname || typeof hostname !== 'string') return true;

  const lower = hostname.toLowerCase().trim();

  // Block known metadata / loopback hostnames
  const blockedHostnames = [
    'localhost',
    'metadata.google.internal',
    'metadata.google',
    '169.254.169.254',
    '0.0.0.0',
    '::1',
    '[::1]',
  ];
  if (blockedHostnames.includes(lower)) return true;

  // If it's an IP address, check ranges directly
  if (net.isIPv4(lower)) {
    return isPrivateIPv4(lower);
  }

  // IPv6 checks
  if (net.isIPv6(lower) || lower.startsWith('[')) {
    const cleanIp = lower.replace(/^\[|\]$/g, '');
    return isPrivateIPv6(cleanIp);
  }

  // Hostname patterns that resolve to internal services
  if (lower.endsWith('.internal') || lower.endsWith('.local') || lower.endsWith('.localhost')) {
    return true;
  }

  return false;
}

function isPrivateIPv4(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some(p => isNaN(p))) return true;

  const [a, b] = parts;

  // 127.0.0.0/8 — loopback
  if (a === 127) return true;
  // 10.0.0.0/8 — private
  if (a === 10) return true;
  // 172.16.0.0/12 — private
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.168.0.0/16 — private
  if (a === 192 && b === 168) return true;
  // 169.254.0.0/16 — link-local
  if (a === 169 && b === 254) return true;
  // 0.0.0.0/8
  if (a === 0) return true;

  return false;
}

/**
 * Expand an IPv6 address (including mixed dotted-quad notation) into its
 * canonical 8-group form, each group a 4-char lowercase hex string. Returns
 * null on any parse failure so callers can fail closed.
 */
function expandIPv6(ip) {
  if (typeof ip !== 'string' || !net.isIPv6(ip)) return null;
  let normalized = ip.toLowerCase();

  // Mixed notation: trailing dotted-quad (e.g. ::ffff:192.0.2.1, 64:ff9b::169.254.169.254)
  if (normalized.includes('.')) {
    const lastColon = normalized.lastIndexOf(':');
    const tail = normalized.slice(lastColon + 1);
    const parts = tail.split('.').map(p => Number(p));
    if (parts.length !== 4 || parts.some(p => !Number.isInteger(p) || p < 0 || p > 255)) {
      return null;
    }
    const hex1 = ((parts[0] << 8) | parts[1]).toString(16).padStart(4, '0');
    const hex2 = ((parts[2] << 8) | parts[3]).toString(16).padStart(4, '0');
    normalized = normalized.slice(0, lastColon + 1) + hex1 + ':' + hex2;
  }

  let groups;
  const dcIdx = normalized.indexOf('::');
  if (dcIdx === -1) {
    groups = normalized.split(':');
    if (groups.length !== 8) return null;
  } else {
    const left = normalized.slice(0, dcIdx);
    const right = normalized.slice(dcIdx + 2);
    const leftGroups = left === '' ? [] : left.split(':');
    const rightGroups = right === '' ? [] : right.split(':');
    const missing = 8 - leftGroups.length - rightGroups.length;
    if (missing < 0) return null;
    groups = [...leftGroups, ...Array(missing).fill('0'), ...rightGroups];
  }

  const padded = groups.map(g => (/^[0-9a-f]{1,4}$/.test(g) ? g.padStart(4, '0') : null));
  if (padded.some(g => g === null)) return null;
  return padded;
}

function ipv4FromLow32(g6, g7) {
  const hi = parseInt(g6, 16);
  const lo = parseInt(g7, 16);
  return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
}

function isPrivateIPv6(ip) {
  const groups = expandIPv6(ip);
  // Fail closed: anything we cannot parse, we treat as private.
  if (!groups) return true;
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups;

  // :: unspecified
  if (groups.every(g => g === '0000')) return true;
  // ::1 loopback
  if (g0 === '0000' && g1 === '0000' && g2 === '0000' && g3 === '0000'
    && g4 === '0000' && g5 === '0000' && g6 === '0000' && g7 === '0001') return true;

  // fc00::/7 — unique-local (first byte 0xFC or 0xFD)
  const firstByte = parseInt(g0.slice(0, 2), 16);
  if (firstByte === 0xfc || firstByte === 0xfd) return true;

  // fe80::/10 — link-local (first 10 bits cover fe80..febf)
  const firstShort = parseInt(g0, 16);
  if (firstShort >= 0xfe80 && firstShort <= 0xfebf) return true;

  // 64:ff9b::/96 — NAT64 well-known prefix (RFC 6052). Translated to IPv4 at
  // the NAT64 gateway, so a URL like http://[64:ff9b::a9fe:a9fe]/ reaches
  // 169.254.169.254. Block the whole prefix — no legitimate outbound use.
  if (g0 === '0064' && g1 === 'ff9b'
    && g2 === '0000' && g3 === '0000' && g4 === '0000' && g5 === '0000') {
    return true;
  }

  // 64:ff9b:1::/48 — NAT64 local-use prefix (RFC 8215). Same reasoning.
  if (g0 === '0064' && g1 === 'ff9b' && g2 === '0001') return true;

  // ::ffff:0:0/96 — IPv4-mapped IPv6 (RFC 4291). Decode the embedded IPv4
  // and re-run through the v4 check so `::ffff:127.0.0.1` and the literal
  // hex form `::ffff:7f00:1` both get caught.
  if (g0 === '0000' && g1 === '0000' && g2 === '0000' && g3 === '0000'
    && g4 === '0000' && g5 === 'ffff') {
    return isPrivateIPv4(ipv4FromLow32(g6, g7));
  }

  // ::/96 — deprecated IPv4-compatible IPv6. Excludes the all-zero
  // unspecified address (handled above). Decode + re-check.
  if (g0 === '0000' && g1 === '0000' && g2 === '0000' && g3 === '0000'
    && g4 === '0000' && g5 === '0000' && !(g6 === '0000' && g7 === '0000')) {
    return isPrivateIPv4(ipv4FromLow32(g6, g7));
  }

  return false;
}

/**
 * Validate a URL string, rejecting private/internal targets.
 * @param {string} urlString - URL to validate
 * @returns {{ valid: boolean, error?: string }}
 */
function validateExternalUrl(urlString) {
  try {
    const parsed = new URL(urlString);
    if (isPrivateIP(parsed.hostname)) {
      return { valid: false, error: 'URL points to a private or internal network address' };
    }
    return { valid: true };
  } catch {
    return { valid: false, error: 'Invalid URL format' };
  }
}

module.exports = { isPrivateIP, validateExternalUrl };
