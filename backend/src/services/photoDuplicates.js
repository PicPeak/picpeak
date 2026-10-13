/**
 * Duplicate detection by content hash (issue 1733, C2).
 *
 * An upload is hashed while it is still a local temp file, and the hash is
 * stored on its photo row (photos.content_sha256, migration 290). Only
 * byte-identical files match, and only within one gallery: a match across
 * galleries would tell one owner what another one holds.
 */

const crypto = require('crypto');
const fs = require('fs');
const { db } = require('../database/db');

/** Hex SHA-256 of a local file, streamed. */
async function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

/** The oldest photo of this gallery with these bytes, or undefined. */
function findDuplicate(eventId, contentSha256) {
  return db('photos')
    .where({ event_id: eventId, content_sha256: contentSha256 })
    .orderBy('id')
    .first('id', 'filename', 'original_filename');
}

/** The name an uploader recognises the existing photo by. */
const duplicateName = (photo) => photo.original_filename || photo.filename;

module.exports = { sha256File, findDuplicate, duplicateName };
