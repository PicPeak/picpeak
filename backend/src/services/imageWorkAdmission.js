const fs = require('fs').promises;
const sharp = require('./isolatedSharp');
const { estimate, refusal } = require('./imageResourcePolicy');

/**
 * Upload-time look at an image's header, so a file over the server's image
 * limits is refused with a message naming the limit instead of failing later
 * in the queue. It never holds an upload back for capacity: a busy or
 * unavailable worker, or a file sharp cannot read, is left to background
 * processing, which waits, retries or records the failure as before.
 */
async function inspect(localPath, originalName, signal, prepared) {
  // A RAW file is processed through its embedded preview; that is checked
  // when the preview is extracted, not by an extra exiftool run per upload.
  if (require('./imageProcessor').isRawFilename(originalName)) return;
  try {
    const cached = prepared?.get(localPath);
    if (cached) {
      if (cached.error) throw refusal(cached.error.message, cached.error.code, cached.error);
      const stat = await fs.stat(localPath);
      if (Object.entries(cached.fingerprint).every(([key, value]) => stat[key] === value)) return;
      // A changed file never inherits a stale verdict.
    }
    estimate(await sharp(localPath, { signal, interactive: true }).metadata());
  } catch (error) {
    if (error.code === 'IMAGE_RESOURCE_LIMIT' || error.code === 'IMAGE_CANCELLED') throw error;
  }
}
async function prepareBatch(files, signal) {
  if (files.length < 8) return null;
  const { isRawFilename } = require('./imageProcessor'); // Lazy: imageProcessor loads this module's callers.
  const entries = files.filter(file => !file.mimetype?.startsWith('video/') && !isRawFilename(file.originalname))
    .map(file => file.path || file.filepath || file.tempFilePath).filter(Boolean);
  if (!entries.length) return null;
  try { return new Map((await sharp.metadataBatch(entries, { signal, interactive: true })).map(result => [result.input, result])); }
  catch (error) { return new Map(entries.map(input => [input, { error: { message: error.message, code: error.code || 'IMAGE_WORKER_FAILED' } }])); }
}
module.exports = { inspect, prepareBatch };
