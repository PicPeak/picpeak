const SHARE_TOKEN_REGEX = /^[0-9a-fA-F]{32}$/;

/**
 * Extracts the share token portion from a stored share link.
 * Supports full URLs, absolute paths, and legacy slug/token formats.
 * @param {string|null|undefined} shareLink
 * @returns {string|null}
 */
function extractShareToken(shareLink) {
  if (!shareLink) {
    return null;
  }

  const trimmed = String(shareLink).trim();
  if (!trimmed) {
    return null;
  }

  // Remove protocol + host when a full URL is stored
  const path = trimmed.replace(/^https?:\/\/[^/]+/i, '');
  const segments = path.split('/').filter(Boolean);
  if (segments.length === 0) {
    return null;
  }

  const candidate = segments[segments.length - 1];
  return candidate || null;
}

/**
 * Returns true if the provided identifier looks like a generated share token.
 * @param {string|null|undefined} identifier
 * @returns {boolean}
 */
function isPotentialShareToken(identifier) {
  if (!identifier) {
    return false;
  }
  return SHARE_TOKEN_REGEX.test(String(identifier).trim());
}

/**
 * Builds the gallery share path depending on whether short URLs are enabled.
 * @param {string} slug
 * @param {string} shareToken
 * @param {boolean} useShort
 * @returns {string}
 */
function buildSharePath(slug, shareToken, useShort) {
  if (!shareToken) {
    throw new Error('shareToken is required to build share path');
  }
  if (useShort || !slug) {
    return `/gallery/${shareToken}`;
  }
  return `/gallery/${slug}/${shareToken}`;
}

module.exports = {
  extractShareToken,
  isPotentialShareToken,
  buildSharePath
};
