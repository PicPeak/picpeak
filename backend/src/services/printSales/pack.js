'use strict';
const archiver = require('archiver');
const { Readable } = require('stream');
const { verifiedStream } = require('./files');
function zip(entries, manifest, storage, options) {
  // Do not open inputs or produce ZIP bytes before upload admission succeeds.
  return Readable.from((async function* () {
    const archive = archiver('zip', { store: true }), sources = [];
    try {
      for (const entry of entries) {
        const source = verifiedStream(storage, entry.asset, options);
        source.on('error', error => archive.destroy(error));
        sources.push(source); archive.append(source, { name: entry.name });
      }
      archive.append(manifest, { name: 'manifest.json' });
      archive.finalize().catch(error => archive.destroy(error));
      for await (const chunk of archive) yield chunk;
    } finally { archive.destroy(); for (const source of sources) source.destroy(); }
  })(), { objectMode: false });
}
module.exports = zip;
