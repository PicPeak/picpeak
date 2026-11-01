/** Validate the byte boundaries written by the ZIP builder before reserving quota. */
function readEntryManifest(job, photoIds, size) {
  if (!Array.isArray(photoIds) || photoIds.length === 0) return null;
  let entries;
  try { entries = JSON.parse(job.entry_manifest); } catch (_) { return null; }
  if (!Array.isArray(entries) || entries.length !== photoIds.length) return null;
  let end = 0;
  const seen = new Set();
  const expected = new Set(photoIds.map(Number));
  for (const entry of entries) {
    const id = Number(entry.photoId);
    if (!expected.has(id) || seen.has(id)
        || !Number.isSafeInteger(entry.start) || !Number.isSafeInteger(entry.end)
        || entry.start !== end || entry.end <= entry.start || entry.end > size) return null;
    seen.add(id);
    end = entry.end;
  }
  return entries;
}

/** Charge an entry once its first bytes were handed to the HTTP response. */
function trackPreparedDelivery(stream, res, manifest) {
  let bytes = 0;
  stream.on('data', (chunk) => { bytes += chunk.length; });
  return () => !res.headersSent || res.statusCode >= 400 ? []
    : manifest.filter((entry) => bytes > entry.start).map((entry) => entry.photoId);
}

module.exports = { readEntryManifest, trackPreparedDelivery };
