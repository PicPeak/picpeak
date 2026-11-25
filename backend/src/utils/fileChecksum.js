const crypto = require('crypto');
const fs = require('fs');

/**
 * SHA-256 of a file as lowercase hex, streamed so the file is never held in
 * memory. Rejects with the stream's error (ENOENT for a missing file).
 * fs.createReadStream is looked up on every call, so a jest.spyOn on it
 * still sees the read.
 */
function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(filePath)
      .on('error', reject)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')));
  });
}

module.exports = { sha256File };
