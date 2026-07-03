/**
 * Resolve the originating client IP address, accounting for reverse proxies.
 * Returns the first entry from X-Forwarded-For when available, otherwise falls back
 * to Express/Node connection properties.
 * @param {import('express').Request} req
 * @returns {string}
 */
function getClientIp(req) {
  if (!req) {
    return '';
  }
  // Use req.ip which respects Express 'trust proxy' setting
  return req.ip || req.connection?.remoteAddress || '';
}

module.exports = { getClientIp };
