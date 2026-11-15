/**
 * The on-disk name a chunked upload is merged under. The client's file name
 * stays metadata only: a valid name of more than 255 bytes (100 CJK
 * characters, for example) cannot be a file name on most Linux filesystems,
 * and the merge failed only after every chunk had been uploaded. A short,
 * plain extension is kept, since the processing pipeline may look at it.
 * The name is unique per merge: where no output name is passed, the
 * thumbnail is named after the source file, and a fixed name would let one
 * upload's thumbnail overwrite another's.
 */
const crypto = require('crypto');
const path = require('path');

function mergedUploadName(filename) {
  const ext = path.extname(path.basename(String(filename || ''))).toLowerCase();
  const unique = `merged-${crypto.randomBytes(12).toString('hex')}`;
  return /^\.[a-z0-9]{1,15}$/.test(ext) ? `${unique}${ext}` : unique;
}

module.exports = { mergedUploadName };
