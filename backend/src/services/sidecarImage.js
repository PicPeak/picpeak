'use strict';

/**
 * Helpers shared by the two ML sidecar processors (faceProcessor,
 * tagProcessor): reading an image into memory for the upload, and the
 * "is this a video" test that skips media with no meaningful single frame.
 */

async function streamToBuffer(stream) {
  if (Buffer.isBuffer(stream)) return stream;
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function isVideoPhoto(photo) {
  return photo.media_type === 'video'
    || (photo.mime_type && photo.mime_type.startsWith('video/'));
}

module.exports = { streamToBuffer, isVideoPhoto };
