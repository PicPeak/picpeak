const path = require('path');
const { resolveExternalPhotoPath } = require('./externalMediaService');
const { safePathJoin } = require('../utils/fileSecurityUtils');

const getStoragePath = () => process.env.STORAGE_PATH || path.join(__dirname, '../../../storage');

/**
 * Resolve a managed photo's relative key under the storage backend.
 * Returns null for external-mode photos (those never live in the managed
 * storage backend; callers should fall back to resolvePhotoFilePath for
 * external references on local disk).
 *
 * Storage layout (relative to STORAGE_PATH or S3 bucket prefix):
 *   events/active/{slug}/individual/{filename}
 *   events/active/{slug}/collages/{filename}
 *
 * Legacy `photo.path` values may already include `events/active/` — we
 * normalize so the returned key always has it exactly once.
 */
function resolvePhotoStorageKey(event, photo) {
  if (!event || !photo) throw new Error('resolvePhotoStorageKey requires event and photo');

  const mode = (photo.source_origin || event.source_mode || 'managed');
  if (mode === 'reference' || mode === 'external') {
    // External photos don't live in the managed backend.
    return null;
  }

  const rel = photo.path ? photo.path.replace(/\\/g, '/').replace(/^\/+/, '') : '';
  if (!rel) {
    throw new Error(`resolvePhotoStorageKey: photo.path is empty for photo ${photo.id}`);
  }

  // Already prefixed (legacy uploads from a previous code revision).
  if (rel.startsWith('events/active/')) return rel;

  return path.posix.join('events/active', rel);
}

/**
 * Resolve absolute photo file path based on event + photo origin
 * Managed: storage/events/active + photo.path (legacy variants supported)
 * External reference: EXTERNAL_MEDIA_ROOT + photo.external_relpath
 */
function resolvePhotoFilePath(event, photo) {
  if (!event || !photo) throw new Error('resolvePhotoFilePath requires event and photo');

  // IMPORTANT: photo.source_origin takes precedence over event.source_mode
  // This allows events in "reference" mode to have mixed sources:
  // - Imported photos: source_origin = 'external'
  // - Uploaded photos: source_origin = 'managed'
  const mode = (photo.source_origin || event.source_mode || 'managed');
  if (mode === 'reference' || mode === 'external') {
    if (!photo.external_relpath) {
      // Mixed-source events: a reference-mode event can also hold managed
      // (uploaded) photos. If we have a regular `path` and no
      // external_relpath, treat this row as managed instead of throwing.
      if (photo.path && !photo.source_origin) {
        const relativeSegment = photo.path.replace(/^\/+/, '');
        return safePathJoin(path.join(getStoragePath(), 'events/active'), relativeSegment);
      }
      throw new Error('Missing external_relpath for external photo');
    }
    // external_relpath is relative to EXTERNAL_MEDIA_ROOT, so the event is not
    // consulted at all (#1163). It used to be relative to event.external_path,
    // which meant importing a second folder into an event silently moved every
    // photo already in it.
    //
    // The duplicate-leaf-segment normalisation that used to live here went with
    // it. It stripped the first segment of the relpath when it matched the last
    // segment of event.external_path — a guess that papered over the
    // double-prefixing this class of bug produced, and one that actively
    // corrupts a root-relative path whose first segment legitimately repeats
    // (external_path 'Trip', relpath 'Trip/x.jpg').
    return resolveExternalPhotoPath(photo);
  }

  const storagePath = getStoragePath();
  const eventsRoot = path.join(storagePath, 'events/active');

  if (photo.path && photo.path.startsWith('events/active/')) {
    // Legacy paths already include prefix; normalize via safe join
    return safePathJoin(storagePath, photo.path.replace(/^events\/active\/?/, 'events/active/'));
  }

  const relativeSegment = photo.path ? photo.path.replace(/^\/+/, '') : '';
  return safePathJoin(eventsRoot, relativeSegment);
}

module.exports = {
  resolvePhotoFilePath,
  resolvePhotoStorageKey,
};
