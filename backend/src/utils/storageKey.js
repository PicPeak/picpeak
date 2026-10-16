const path = require('path');

/**
 * Do these two stored paths address the same object?
 *
 * Compared the way the storage backends do, not as raw strings.
 * LocalFsStorage._resolve and S3StorageBackend._key both fold `\` to `/` and
 * strip a leading `./`, so `thumbnails\thumb_x.jpg`, `./thumbnails/thumb_x.jpg`
 * and `thumbnails/thumb_x.jpg` are all one file. A legacy thumbnail_path in
 * any of those shapes would compare unequal to the freshly generated POSIX
 * key — and a "the key moved, delete the old one" branch would then
 * delete the thumbnail that had just been written, leaving every regenerated
 * photo pointing at nothing (the thumbnail regeneration in adminThumbnails.js
 * and renditionRefresh both make that decision).
 */
// As LocalFsStorage._resolve reads a key (path.posix.normalize), the coarser
// of the two backends: S3 keeps an interior `./` or `//` as its own object,
// and calling two keys equal here can only keep a file, never delete one.
const canonicalStorageKey = (key) => {
  let canonical = path.posix.normalize(String(key).replace(/\\/g, '/'));
  while (/^\.?\//.test(canonical)) canonical = canonical.replace(/^\.?\/+/, '');
  return canonical;
};
function sameStorageKey(a, b) {
  return canonicalStorageKey(a) === canonicalStorageKey(b);
}

module.exports = { canonicalStorageKey, sameStorageKey };
