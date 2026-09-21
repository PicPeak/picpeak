/**
 * rateLimitKey — the per-client key the rate limiters count against.
 *
 * For IPv4 that is the address. For IPv6 it is the /64 the address sits in:
 * a /64 is the smallest block an end site is handed, and a single host can use
 * every address in it, so keying on the full address lets one machine present
 * a fresh "client" per request and never spend a budget. The 5-failed-logins
 * limit was unlimited for anyone on IPv6.
 *
 * /64 and not wider on purpose. Many ISPs delegate a /56 or /48, so a
 * determined attacker still gets a few hundred buckets; but mobile carriers
 * give each handset its own /64, and a wider mask would make unrelated guests
 * on the same carrier share one budget. Bounded is the goal, not zero.
 *
 * IPv4-mapped addresses (::ffff:203.0.113.7) collapse to the plain IPv4 form so
 * a client cannot hold two buckets by arriving over either socket family; the
 * deprecated IPv4-compatible form (::203.0.113.7) does the same.
 *
 * A proxy may forward an IPv6 client in URI form — [2001:db8::1], or with a
 * port, [2001:db8::1]:443 — and Express hands that through as req.ip. The
 * brackets are stripped first, or the address fails to parse and every
 * address in the /64 keys on its own again.
 *
 * Read req.ip only — see utils/clientIp.js for why the forwarded headers must
 * never be parsed by hand.
 */
const net = require('net');

// Eight 16-bit groups, or null when the text is not an IPv6 address.
function ipv6Groups(text) {
  let addr = text.split('%')[0]; // zone id: fe80::1%eth0
  if (!net.isIPv6(addr)) return null;

  // A dotted IPv4 tail (::ffff:203.0.113.7) is the last two groups.
  const v4 = addr.match(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const [b1, b2, b3, b4] = v4.slice(1).map(Number);
    addr = `${addr.slice(0, v4.index)}${((b1 << 8) | b2).toString(16)}:${((b3 << 8) | b4).toString(16)}`;
  }

  const [head, tail] = addr.split('::');
  const left = head ? head.split(':') : [];
  if (tail === undefined) return left.map((g) => parseInt(g, 16));
  const right = tail ? tail.split(':') : [];
  const zeros = new Array(8 - left.length - right.length).fill('0');
  return [...left, ...zeros, ...right].map((g) => parseInt(g, 16));
}

/**
 * @param {import('express').Request} req
 * @returns {string}
 */
function rateLimitKey(req) {
  const raw = (req && req.ip) || '';
  const bracketed = raw.match(/^\[([^\]]+)\](?::\d+)?$/);
  const ip = bracketed ? bracketed[1] : raw;
  const groups = ipv6Groups(ip);
  if (!groups) return raw;

  const isV4Mapped = groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff;
  // Only the dotted spelling: ::1 is loopback, not the IPv4 address 0.0.0.1.
  const isV4Compatible = groups.slice(0, 6).every((g) => g === 0) && /\.\d+$/.test(ip);
  if (isV4Mapped || isV4Compatible) {
    return [groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff].join('.');
  }
  return `${groups.slice(0, 4).map((g) => g.toString(16)).join(':')}::/64`;
}

module.exports = { rateLimitKey };
