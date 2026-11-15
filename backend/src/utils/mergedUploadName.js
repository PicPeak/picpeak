/**
 * The on-disk name a chunked upload is merged under. The client's file name
 * stays metadata only: a valid name of more than 255 bytes (100 CJK
 * characters, for example) cannot be a file name on most Linux filesystems,
 * and the merge failed only after every chunk had been uploaded. A short,
 * plain extension is kept, since the processing pipeline may look at it.
 */
const path = require('path');

function mergedUploadName(filename) {
  const ext = path.extname(path.basename(String(filename || ''))).toLowerCase();
  return /^\.[a-z0-9]{1,15}$/.test(ext) ? `merged${ext}` : 'merged';
}

module.exports = { mergedUploadName };
