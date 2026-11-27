/**
 * Rendered public website pages, keyed by path. Same lifetime as the
 * single-page public site (PUBLIC_SITE_CACHE_TTL_MS). Cleared on publish, on a
 * gallery's "show on website" change and whenever the public-site cache is
 * cleared (branding and settings saves), so it has no dependencies of its own.
 *
 * Only published pages ever go in here; the editor's preview is rendered per
 * request and never cached.
 */
const TTL_MS = Number(process.env.PUBLIC_SITE_CACHE_TTL_MS || 60_000);

const entries = new Map();
// Bumped on every clear. A render captures it before it reads anything and
// stores its result only if no clear came in between: a render that read the
// document before a publish must not put the old page back after it.
let generation = 0;

function cacheGeneration() {
  return generation;
}

/** The cached value (which may be null, a cached miss), or undefined. */
function getCached(key) {
  const hit = entries.get(key);
  if (!hit) return undefined;
  if (hit.expiresAt <= Date.now()) {
    entries.delete(key);
    return undefined;
  }
  return hit.value;
}

function setCached(key, value, startedAt) {
  if (startedAt !== generation) return;
  // A bound on distinct keys: only real page paths are cached, but a crawler
  // walking random slugs must not grow the map without limit.
  if (entries.size >= 500) entries.clear();
  entries.set(key, { value, expiresAt: Date.now() + TTL_MS });
}

function clearWebsiteCache() {
  generation += 1;
  entries.clear();
}

module.exports = { cacheGeneration, getCached, setCached, clearWebsiteCache };
