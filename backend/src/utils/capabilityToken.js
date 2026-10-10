const crypto = require('crypto');

/** One-way storage form for single-use invitation and password-reset tokens. */
function digestCapabilityToken(rawToken) {
  return crypto.createHash('sha256').update(String(rawToken)).digest('hex');
}

/**
 * The legacy `token` column is NOT NULL and unique. Keep a digest there as a
 * non-secret compatibility placeholder while all new lookups use the explicit
 * `token_digest` column. The raw bearer value must never reach the database.
 */
function capabilityTokenColumns(rawToken) {
  const digest = digestCapabilityToken(rawToken);
  return { token: digest, token_digest: digest };
}

module.exports = { digestCapabilityToken, capabilityTokenColumns };
