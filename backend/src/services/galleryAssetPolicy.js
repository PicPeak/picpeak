const { db } = require('../database/db');
const { parseBooleanInput } = require('../utils/parsers');
const { isPhotoHiddenFromViewer } = require('../utils/photoVisibility');
const folderTree = require('./folderTreeService');
const { currentDownloadLimit, isOriginalWithheld, drawsOnQuota, clientOnlyError } = require('./downloadQuota');

/**
 * The grant itself, before any download policy. Video playback continues
 * where downloads are off, but never past a refusal from here.
 */
function grantDenial(req, photo = null) {
  const grant = req.galleryAccess;
  if (!grant || !['public', 'gallery', 'admin'].includes(grant.kind)
      || Number(grant.eventId) !== Number(req.event?.id)) return { error: 'Photo not available' };
  if (grant.session?.accessLevel === 'slideshow' || req.accessLevel === 'slideshow') {
    return { error: 'Slideshow tokens are display-only' };
  }
  if (photo && (Number(photo.event_id) !== Number(req.event.id)
      || isPhotoHiddenFromViewer(photo, req.accessLevel))) return { error: 'Photo not available' };
  return null;
}

/**
 * Visibility authorizes presentation, not source bytes. Shared by gallery
 * display and download entry points; download quota reservation/settlement
 * stays with the existing byte-delivery callers, never with this predicate.
 */
async function originalAssetDenial(req, photo = null, { display = false } = {}) {
  const grant = req.galleryAccess;
  const refused = grantDenial(req, photo);
  if (refused) return refused;
  // An authorized admin preview inspects originals without changing the
  // viewer's download policy. Downloads themselves retain their old policy.
  if (display && grant.kind === 'admin') return null;
  if (!parseBooleanInput(req.event.allow_downloads, true)) {
    return { error: 'Downloads are disabled for this gallery' };
  }
  if (photo?.category_id) {
    const category = await db('photo_categories').where('id', photo.category_id).first('allow_downloads');
    if (category && !parseBooleanInput(category.allow_downloads, true)) {
      return { error: 'Downloads are disabled for this category' };
    }
  }
  if (photo?.folder_id && (await folderTree.downloadBlockedFolderIds(req.event.id)).includes(Number(photo.folder_id))) {
    return { error: 'Downloads are disabled for this folder' };
  }
  if (display && photo) {
    const downloadLimit = await currentDownloadLimit(req.event);
    if (await isOriginalWithheld({ ...req.event, download_limit: downloadLimit }, photo)) {
      const video = photo.media_type === 'video' || String(photo.mime_type || '').startsWith('video/');
      // Eligible clients still use admitVideoStream's atomic reservation
      // when it is the original they are streamed.
      if (!video || !drawsOnQuota(req)) return clientOnlyError();
    }
  }
  return null;
}

// DB rendition pointers are not authority to read arbitrary source keys.
// These namespaces are written by imageProcessor's bounded generators and,
// for `web`, by videoRenditionService.
function isPresentationRenditionKey(key, kind) {
  const prefixes = { preview: 'previews/preview_', hero: 'heroes/hero_', thumbnail: 'thumbnails/thumb_',
    web: 'videos/web_' };
  const prefix = prefixes[kind];
  return typeof key === 'string' && !!prefix && key.startsWith(prefix)
    && !key.slice(prefix.length).includes('/') && !key.includes('\\');
}

module.exports = { originalAssetDenial, grantDenial, isPresentationRenditionKey };
