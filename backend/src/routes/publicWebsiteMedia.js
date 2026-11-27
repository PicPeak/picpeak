/**
 * Images (and hero videos) of the public website (issue 2618), mounted at
 * /site-media outside /api so crawlers that honour robots.txt's
 * `Disallow: /api` can still index a portfolio.
 *
 *   GET /:token/:size   token = <p|a><id>.<sig>, size = 640 | 1280 | 1920 | video
 *
 * Only signed URLs work (services/website/media.js), only while the
 * `websiteBuilder` flag is on, and a gallery photo is re-checked for
 * eligibility on every request. Only preview renditions are served — a
 * missing one is a 404, never the original — and a gallery photo exactly as
 * the gallery shows it to a guest: with its watermark, capped at maximum
 * protection (services/galleryViewRendition.js). Uploads are served as they are.
 */
const express = require('express');
const path = require('path');
const { db } = require('../database/db');
const logger = require('../utils/logger');
const { isFeatureEnabled } = require('../middleware/requireFeatureFlag');
const { getStorage } = require('../services/storage');
const { pipeStreamToResponse } = require('../utils/streamResponse');
const { ensurePreviewImageAtWidth } = require('../services/imageProcessor');
const { isPresentationRenditionKey } = require('../services/galleryAssetPolicy');
const renditionRefresh = require('../services/renditionRefresh');
const media = require('../services/website/media');
const { capPreviewRendition, watermarkPreviewRendition } = require('../services/galleryViewRendition');

const router = express.Router();

const CONTENT_TYPES = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.mp4': 'video/mp4' };

function notFound(res) {
  res.status(404).type('text/plain').send('Not found');
}

// A photo's rendition as { key, view }, or { redirect } when the URL names
// an older version of the picture or of its watermark (or none): the
// current URL then serves the current one.
async function photoRendition(id, width, version) {
  const eligible = await media.loadEligiblePhotos([id]);
  if (!eligible.has(id)) return null;
  const { view } = eligible.get(id);
  let photo = await media.guestPhotoQuery().where('photos.id', id).first('photos.*');
  if (!photo) return null;
  // Renditions written before EXIF stripping carry the GPS position: clean
  // them before the first public byte, as the OG cover does.
  if (renditionRefresh.needsRefresh(photo)) {
    if (!(await renditionRefresh.refreshCover(photo))) return null;
    photo = await media.guestPhotoQuery().where('photos.id', id).first('photos.*');
    if (!photo) return null;
  }
  const current = media.photoVersion({ ...photo, view });
  if (version !== current) return { redirect: `${media.mediaBase({ source: 'photo', id }, current)}/${width}` };
  const key = await ensurePreviewImageAtWidth(photo, width);
  return isPresentationRenditionKey(key, 'preview') ? { key, view } : null;
}

// What the gallery would send a guest for this rendition: capped at maximum
// protection, else watermarked when its gallery marks it. Null: the stored
// rendition as it is.
async function guestCopy({ key, view }) {
  if (view.capped) return capPreviewRendition(key, view.watermark);
  if (view.watermark) return { buffer: await watermarkPreviewRendition(key, view.watermark), contentType: null };
  return null;
}

async function assetRendition(publicId, size) {
  const asset = await db('website_assets').where({ public_id: publicId }).first();
  if (!asset) return null;
  const keys = media.parseRenditionKeys(asset);
  const key = size === 'video' ? (asset.kind === 'video' ? keys.video : null) : (asset.kind === 'image' ? keys[size] : null);
  // Only keys this feature wrote: a tampered row cannot point outside them.
  const own = new RegExp(`^website/${publicId}/(w(640|1280|1920)\\.(jpg|webp)|video\\.mp4)$`);
  return typeof key === 'string' && own.test(key) ? key : null;
}

router.get('/:token/:size', async (req, res) => {
  try {
    if (!(await isFeatureEnabled('websiteBuilder'))) return notFound(res);
    const ref = media.parseMediaToken(req.params.token);
    if (!ref) return notFound(res);
    const { size } = req.params;
    const width = Number(size);
    const isVideo = size === 'video';
    if (!isVideo && !media.MEDIA_WIDTHS.includes(width)) return notFound(res);
    if (isVideo && ref.kind !== 'a') return notFound(res);

    const found = ref.kind === 'p' ? await photoRendition(ref.id, width, ref.version) : await assetRendition(ref.id, isVideo ? 'video' : String(width));
    if (!found) return notFound(res);
    if (found.redirect) {
      // Not cached: the next replacement moves the target again.
      res.set('Cache-Control', 'no-cache');
      return res.redirect(302, found.redirect);
    }
    // Builder uploads are the owner's own images, never watermarked.
    const key = ref.kind === 'p' ? found.key : found;

    const storage = getStorage();
    const stat = await storage.stat(key);
    if (!stat) return notFound(res);
    const contentType = CONTENT_TYPES[path.extname(key).toLowerCase()];
    if (!contentType) return notFound(res);
    const size_ = Number(stat.size);
    const headers = {
      'Content-Type': contentType,
      // Public, but not immutable: a gallery that leaves the website should
      // drop out of shared caches within a day.
      'Cache-Control': 'public, max-age=86400',
      'X-Content-Type-Options': 'nosniff',
      'Accept-Ranges': isVideo ? 'bytes' : 'none',
    };

    // A gallery photo leaves as the gallery shows it: watermarked or capped.
    const copy = ref.kind === 'p' ? await guestCopy(found) : null;
    if (copy) {
      res.status(200).set({ ...headers, 'Content-Type': copy.contentType || contentType, 'Content-Length': copy.buffer.length });
      return res.end(copy.buffer);
    }

    const range = isVideo ? req.headers.range : null;
    if (range) {
      const match = /^bytes=(\d+)-(\d*)$/.exec(range);
      const start = match ? Number(match[1]) : NaN;
      const end = match && match[2] ? Number(match[2]) : size_ - 1;
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || start >= size_) {
        res.set('Content-Range', `bytes */${size_}`);
        return res.status(416).end();
      }
      const boundedEnd = Math.min(end, size_ - 1);
      const stream = await storage.getRange(key, start, boundedEnd);
      res.status(206).set({ ...headers, 'Content-Range': `bytes ${start}-${boundedEnd}/${size_}`, 'Content-Length': boundedEnd - start + 1 });
      return pipeStreamToResponse(stream, res, { context: 'website media range' });
    }
    const stream = await storage.get(key);
    res.status(200).set({ ...headers, 'Content-Length': size_ });
    return pipeStreamToResponse(stream, res, { context: 'website media' });
  } catch (error) {
    logger.error('Website media failed', { error: error.message });
    if (!res.headersSent) res.status(500).type('text/plain').send('Internal server error');
  }
});

module.exports = router;
