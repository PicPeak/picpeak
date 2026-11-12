'use strict';
const { NotFoundError } = require('../../utils/errors');
const { pipeStreamToResponse } = require('../../utils/streamResponse');
const { isStorageNotFoundError } = require('../storage/storageErrors');
const logger = require('../../utils/logger');

/** The rendition widths a client may ask for: tiles and the detail view. */
const SIZES = ['480', '1200'];
// Rendered renditions, newest last. An image id names one upload's bytes for
// good (a new upload gets a new id, nothing rewrites one), so an entry never
// goes stale; the byte budget only keeps memory bounded.
const BUDGET = 32 * 1024 * 1024;
const cache = new Map();
let cached = 0;

async function bytesOf(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}
function remember(key, buffer) {
  cache.set(key, buffer);
  cached += buffer.length;
  for (const [oldest, value] of cache) {
    if (cached <= BUDGET) break;
    cache.delete(oldest);
    cached -= value.length;
  }
}
const pending = new Map();
async function rendition(image, size) {
  const key = `${image.id}:${size}`;
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  if (!pending.has(key)) {
    const work = (async () => {
      let source;
      try {
        source = await bytesOf(await require('../storage').getStorage().get(image.storage_key));
      } catch (error) {
        if (isStorageNotFoundError(error)) throw new NotFoundError('Image');
        throw error;
      }
      const width = Number(size);
      const buffer = await require('../isolatedSharp')(source, { interactive: true })
        .resize(width, width, { fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 80 })
        .toBuffer();
      remember(key, buffer);
      return buffer;
    })().finally(() => pending.delete(key));
    pending.set(key, work);
  }
  return pending.get(key);
}

/**
 * Answers with a product image, after the route's own access check. Without
 * `size` it is the stored original, as before; with one, a WebP no wider or
 * taller than that. The bytes behind an id never change, so the browser may
 * keep them: privately, and revalidated by the upload's hash. Only a served
 * image carries those headers, so a failure is never kept.
 */
async function sendImage(req, res, image, context) {
  const size = req.query.size ? String(req.query.size) : null;
  const etag = `"${image.sha256 || image.id}-${size || 'original'}"`;
  const keep = () => res.set({ 'Cache-Control': 'private, max-age=604800, immutable', ETag: etag });
  if (req.headers['if-none-match'] === etag) {
    keep();
    return res.status(304).end();
  }
  const original = async (cache) => {
    const stream = await require('../storage').getStorage().get(image.storage_key);
    cache();
    res.type('png');
    return pipeStreamToResponse(stream, res, { context });
  };
  if (!size) return original(keep);
  let buffer;
  try {
    buffer = await rendition(image, size);
  } catch (error) {
    if (error instanceof NotFoundError) throw error;
    // A busy or failing image pool must not turn into a 503: the gallery's
    // API client reads any 503 as maintenance. The original still shows,
    // and is not kept under the rendition's ETag.
    logger.warn(`${context}: rendition ${size} failed, serving the original`, { imageId: image.id, error: error.message });
    return original(() => res.set('Cache-Control', 'private, no-store'));
  }
  keep();
  res.type('webp').send(buffer);
}

module.exports = { SIZES, sendImage };
