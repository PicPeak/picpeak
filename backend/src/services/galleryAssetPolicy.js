const { db } = require('../database/db');
const { parseBooleanInput } = require('../utils/parsers');
const { isPhotoHiddenFromViewer } = require('../utils/photoVisibility');
const folderTree = require('./folderTreeService');
const { currentDownloadLimit, isOriginalWithheld, drawsOnQuota, clientOnlyError } = require('./downloadQuota');
const { ORIGINAL, resolveEventDownloadPolicy, pickRequestedResolution } = require('../utils/downloadResolutions');
const { originalNeedsPreview } = require('../utils/rawFormats');
const watermarkService = require('./watermarkService');

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

const FULL_RESOLUTION_REFUSED = { error: 'Full resolution is not available for this gallery' };

/**
 * Full-resolution zoom in the lightbox (issue 1733): the gallery-wide half of
 * the rule. A viewer may load an original inline only where an ordinary
 * download would hand them those exact bytes anyway, unwatermarked and
 * uncounted. So never for a slideshow session, with downloads off, with a
 * watermark on downloads or on the display routes, with downloads held to a
 * reduced resolution, or while a download limit is configured (zooming must
 * neither draw on the quota nor go around it; an admin preview gets no
 * exemption here).
 *
 * Nor where the gallery is set to keep the file out of the viewer's hands on
 * the page itself: protection level enhanced or maximum (print-screen and
 * DevTools detection, canvas rendering) or canvas rendering on its own.
 * Those are the protection inputs that ship off, so each is a decision
 * someone made; `enable_devtools_protection` ships on for every gallery and
 * says nothing. The right-click block does not refuse: zoom is only offered
 * where a download button hands over the same original, so the block
 * protects nothing extra here, and the lightbox keeps suppressing the
 * context menu on the zoomed image. Enforced here because the client only
 * hides the feature. Shared by the photo list, which only advertises the
 * feature, and by the photo route, which is what enforces it.
 */
async function galleryFullResolutionDenial(event, accessLevel) {
  if (accessLevel === 'slideshow') return FULL_RESOLUTION_REFUSED;
  if (!parseBooleanInput(event.allow_downloads, true)) return FULL_RESOLUTION_REFUSED;
  if (await currentDownloadLimit(event)) return FULL_RESOLUTION_REFUSED;
  if (['enhanced', 'maximum'].includes(event.protection_level)
      || parseBooleanInput(event.use_canvas_rendering, false)) return FULL_RESOLUTION_REFUSED;
  // Unreadable settings refuse: the answer has to be "no watermark", not "unknown".
  const watermark = await watermarkService.getWatermarkSettings();
  if (!watermark || watermark.enabled || parseBooleanInput(event.watermark_downloads, false)) {
    return FULL_RESOLUTION_REFUSED;
  }
  // No inline route serves a reduced size, so a capped gallery only
  // qualifies when the viewer may pick the original for a download.
  const policy = await resolveEventDownloadPolicy(event);
  if (policy.standardBox && pickRequestedResolution(policy, ORIGINAL) !== ORIGINAL) return FULL_RESOLUTION_REFUSED;
  return null;
}

/** The whole rule for one photo: the download policy for it, then the above. */
async function fullResolutionDenial(req, photo) {
  const video = photo.media_type === 'video' || String(photo.mime_type || '').startsWith('video/');
  // An original no browser renders (camera RAW, HEIC) has nothing to zoom into.
  if (video || originalNeedsPreview(photo)) return FULL_RESOLUTION_REFUSED;
  return (await originalAssetDenial(req, photo))
    || galleryFullResolutionDenial(req.event, req.accessLevel);
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

module.exports = {
  originalAssetDenial, grantDenial, isPresentationRenditionKey,
  galleryFullResolutionDenial, fullResolutionDenial,
};
