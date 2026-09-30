/**
 * Which files an external-media folder contributes to an event.
 *
 * Kept out of externalMediaService on purpose: that module is loaded by
 * photoResolver, and with it by nearly every route, and must not grow a
 * dependency on the upload settings just to answer this.
 */
const path = require('path');
const { EXTENSION_TO_MIME, getAllowedMimeTypes } = require('./uploadSettings');

const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp'];

// Every video extension the upload pipeline knows how to process.
const VIDEO_EXTENSIONS = Object.keys(EXTENSION_TO_MIME)
  .filter((ext) => EXTENSION_TO_MIME[ext].startsWith('video/'))
  .map((ext) => `.${ext}`);

const isVideoFile = (name) => VIDEO_EXTENSIONS.includes(path.extname(name).toLowerCase());

/** The MIME type stored for an imported video, from its extension. */
const videoMimeType = (name) => EXTENSION_TO_MIME[path.extname(name).slice(1).toLowerCase()];

/**
 * The extensions the picker lists and an import takes, right now.
 *
 * Images are the fixed list they always were. Videos are taken only for the
 * types the admin allows for uploads (Settings, General, allowed file types).
 * That is deliberate: a reference folder that has always held clips next to
 * its photos must not start publishing them to guests because of an upgrade.
 * An install that accepts video uploads has made that decision already.
 */
async function importableExtensions() {
  const allowed = await getAllowedMimeTypes();
  return [
    ...IMAGE_EXTENSIONS,
    ...VIDEO_EXTENSIONS.filter((ext) => allowed.includes(EXTENSION_TO_MIME[ext.slice(1)])),
  ];
}

module.exports = {
  IMAGE_EXTENSIONS,
  VIDEO_EXTENSIONS,
  isVideoFile,
  videoMimeType,
  importableExtensions,
};
