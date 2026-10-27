const StreamZip = require('node-stream-zip');
const { once } = require('events');
const { readEntryManifest } = require('./downloadJobDelivery');

/** Read ZIP/ZIP64 local-header offsets after the output has fully closed.
 * Archiver's entry event and pointer can precede buffered output bytes.
 */
async function buildEntryManifest(file, packaged, size) {
  const zip = new StreamZip({ file, storeEntries: true });
  try {
    await once(zip, 'ready');
    const entries = Object.values(zip.entries()).sort((a, b) => a.offset - b.offset);
    if (entries.length !== packaged.length || entries.some((entry, i) => entry.isDirectory || entry.name !== packaged[i].name)) {
      throw new Error('Prepared ZIP entries do not match the packaged photos');
    }
    const manifest = entries.map((entry, i) => ({
      photoId: packaged[i].photoId,
      start: entry.offset,
      end: entries[i + 1]?.offset ?? zip.centralDirectory.offset,
    }));
    if (!readEntryManifest({ entry_manifest: JSON.stringify(manifest) }, packaged.map((entry) => entry.photoId), size)) {
      throw new Error('Prepared ZIP has invalid entry boundaries');
    }
    return manifest;
  } finally { await new Promise((resolve) => zip.close(resolve)); }
}

module.exports = { buildEntryManifest };
