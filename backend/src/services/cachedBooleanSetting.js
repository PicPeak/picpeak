const { db } = require('../database/db');
const logger = require('../utils/logger');

const CACHE_TTL_MS = 60_000;

/**
 * An on/off app setting that defaults to off, cached 60 s.
 *
 * On only for true, 'true', 1 or '1' (a JSON-encoded string is parsed once).
 * A failed read logs `Failed to read the ${label} setting:` and answers off
 * for the next minute. `get({ fresh: true })` skips the cache.
 */
function createCachedBooleanSetting(key, label) {
  let cached = false;
  let expiresAt = 0;

  async function get({ fresh = false } = {}) {
    if (!fresh && Date.now() < expiresAt) return cached;
    try {
      const row = await db('app_settings').where({ setting_key: key }).first();
      let value = row ? row.setting_value : null;
      if (typeof value === 'string') {
        try { value = JSON.parse(value); } catch { /* keep the string */ }
      }
      cached = value === true || value === 'true' || value === 1 || value === '1';
    } catch (error) {
      logger.error(`Failed to read the ${label} setting:`, error.message);
      cached = false;
    }
    expiresAt = Date.now() + CACHE_TTL_MS;
    return cached;
  }

  function clear() {
    expiresAt = 0;
  }

  return { get, clear };
}

module.exports = { createCachedBooleanSetting };
