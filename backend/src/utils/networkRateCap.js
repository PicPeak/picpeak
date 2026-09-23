/**
 * The per-network ceiling that sits above a per-device rate limit.
 *
 * The secure-image limiters count per device: the network key (rateLimitKey:
 * the IPv4 address, or the IPv6 /64) hashed together with request headers, so that guests sharing one connection — a venue's wifi at
 * a wedding — each keep their own budget. The price is that the headers are
 * chosen by the client: rotating the User-Agent is a fresh "device" and a
 * fresh budget, without limit.
 *
 * The network cap bounds that. Every request also counts against the network
 * key alone, with a budget of MULTIPLIER times the per-device one. A room of
 * real guests stays well under it; a script rotating headers from one
 * connection reaches it and stops there.
 *
 * 20 by default: under enhanced protection the lightbox loads full images
 * through the secure-image limiter at 30/min per device, so the network
 * allows 600/min — dozens of guests browsing at once. An operator running
 * large events behind one address can raise it with
 * RATE_LIMIT_NETWORK_MULTIPLIER; a value below 1 or not a number falls back
 * to the default.
 *
 * The feedback limiter has its own per-network budget
 * (consumeFeedbackLimit in middleware/feedbackRateLimit.js); this multiplier
 * does not apply there.
 */
const DEFAULT_NETWORK_MULTIPLIER = 20;

function networkMultiplier() {
  const raw = Number(process.env.RATE_LIMIT_NETWORK_MULTIPLIER);
  return Number.isFinite(raw) && raw >= 1 ? raw : DEFAULT_NETWORK_MULTIPLIER;
}

function networkLimit(deviceLimit) {
  return Math.ceil(deviceLimit * networkMultiplier());
}

module.exports = { DEFAULT_NETWORK_MULTIPLIER, networkMultiplier, networkLimit };
