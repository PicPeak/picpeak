'use strict';
const archiver = require('archiver');
const { verifiedStream } = require('./files');
function zip(entries, manifest, storage) {
  const archive = archiver('zip', { store: true }), sources = [];
  // Lazy reads keep a large S3 order from exhausting its HTTP connection pool.
  archive.once('close', () => { for (const source of sources) source.destroy(); });
  for (const entry of entries) {
    const source = verifiedStream(storage, entry.asset);
    source.on('error', error => archive.destroy(error));
    sources.push(source); archive.append(source, { name: entry.name });
  }
  archive.append(manifest, { name: 'manifest.json' });
  archive.finalize().catch(error => archive.destroy(error));
  return archive;
}
module.exports = zip;
