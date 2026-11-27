/**
 * Images and hero videos uploaded in the website builder (issue 2618).
 *
 * An image goes through the ordinary preview pipeline
 * (imageProcessor.generatePreviewImage): one rendition per media tier,
 * EXIF-stripped and orientation-corrected. A video is remuxed (or transcoded
 * when a browser could not play it) without its container metadata, so a
 * phone's recording location never reaches the public site. The uploaded
 * originals are not kept, so these files are the only copy: they live under
 * website/<publicId>/ (w640.jpg, w1280.jpg, w1920.jpg, video.mp4), a root
 * every backup, export and recovery inventory includes, and not among the
 * regenerable previews/.
 */
const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');
// The worker-isolated Sharp (as imageProcessor uses): the native module is
// loaded in its worker on first use, never when this module loads.
const sharp = require('../isolatedSharp');
const { db } = require('../../database/db');
const { AppError } = require('../../utils/errors');
const logger = require('../../utils/logger');
const { escapeLikePattern, likeWithEscape, unicodeSearchForms } = require('../../utils/sqlSecurity');
const { getStorage } = require('../storage');
const { getStoragePath } = require('../../config/storage');
const { sniffImageFileType, validateFileContent } = require('../../utils/fileSecurityUtils');
const { generatePreviewImage, orientedDimensions } = require('../imageProcessor');
const { MEDIA_WIDTHS, parseRenditionKeys, mediaBase } = require('./media');

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const MAX_VIDEO_SECONDS = 120;

function publicAsset(row) {
  const ref = { source: 'asset', id: row.public_id };
  const keys = parseRenditionKeys(row);
  return {
    id: row.public_id,
    kind: row.kind,
    width: row.width,
    height: row.height,
    originalFilename: row.original_filename,
    sizeBytes: Number(row.size_bytes) || null,
    createdAt: row.created_at,
    previewUrl: row.kind === 'image' && keys[640] ? `${mediaBase(ref)}/640` : null,
    videoUrl: row.kind === 'video' ? `${mediaBase(ref)}/video` : null,
  };
}

async function listAssets({ q = '', page = 1, pageSize = 60, kind = null } = {}) {
  let query = db('website_assets');
  if (kind) query = query.where({ kind });
  if (q) {
    query = query.where((b) => {
      for (const form of unicodeSearchForms(q)) b.orWhereRaw(likeWithEscape('original_filename'), [`%${escapeLikePattern(form)}%`]);
    });
  }
  const rows = await query.orderBy('created_at', 'desc').orderBy('id', 'desc').limit(pageSize + 1).offset((page - 1) * pageSize);
  return { assets: rows.slice(0, pageSize).map(publicAsset), hasMore: rows.length > pageSize };
}

async function insertAsset(values) {
  await db('website_assets').insert({ ...values, created_at: new Date().toISOString() });
  return publicAsset(await db('website_assets').where({ public_id: values.public_id }).first());
}

async function createImageAsset(file, adminId) {
  const sniffed = await sniffImageFileType(file.path);
  if (!IMAGE_TYPES.includes(sniffed)) {
    throw new AppError('Upload a JPEG, PNG, WebP or GIF image', 400, 'WEBSITE_ASSET_TYPE');
  }
  let metadata;
  try {
    metadata = await sharp(file.path, { limitInputPixels: 268402689 }).metadata();
  } catch {
    throw new AppError('The image could not be read', 400, 'WEBSITE_ASSET_UNREADABLE');
  }
  const { width, height } = orientedDimensions(metadata);
  const publicId = crypto.randomBytes(12).toString('hex');
  const keys = {};
  const storage = getStorage();
  for (const tier of MEDIA_WIDTHS) {
    // eslint-disable-next-line no-await-in-loop -- one tier at a time keeps peak memory at one decode
    const rendered = await generatePreviewImage(file.path, { outputBasename: `site_${publicId}`, longEdge: tier, regenerate: true });
    if (!rendered) {
      await removeKeys(keys);
      throw new AppError('The image could not be processed', 400, 'WEBSITE_ASSET_UNREADABLE');
    }
    const key = `website/${publicId}/w${tier}${path.extname(rendered)}`;
    // eslint-disable-next-line no-await-in-loop -- see above
    await storage.rename(rendered, key);
    keys[tier] = key;
  }
  return insertAsset({
    public_id: publicId,
    kind: 'image',
    mime_type: sniffed,
    width,
    height,
    rendition_keys: JSON.stringify(keys),
    original_filename: String(file.originalname || '').slice(0, 255),
    size_bytes: file.size,
    created_by: adminId,
  });
}

async function createVideoAsset(file, adminId) {
  if (!(await validateFileContent(file.path, 'video/mp4'))) {
    throw new AppError('Upload an MP4 video', 400, 'WEBSITE_ASSET_TYPE');
  }
  const video = require('../videoRenditionService');
  const probed = await video.probe(file.path).catch(() => null);
  if (!probed) throw new AppError('The video could not be read', 400, 'WEBSITE_ASSET_UNREADABLE');
  const duration = Number(probed.duration);
  if (Number.isFinite(duration) && duration > MAX_VIDEO_SECONDS) {
    throw new AppError(`A hero video can be at most ${MAX_VIDEO_SECONDS} seconds long`, 400, 'WEBSITE_ASSET_TOO_LONG');
  }
  const publicId = crypto.randomBytes(12).toString('hex');
  const tmpOut = path.join(getStoragePath(), 'temp', `site_${publicId}.mp4`);
  try {
    // The gallery web copy's decision: remux what plays already, else
    // transcode, tone-mapping HDR to SDR when this ffmpeg can.
    const remux = video.playsInBrowser(probed, await video.hasFaststart(file.path));
    const { hdr, toneMap } = await video.hdrPlan(probed, remux);
    if (hdr && !toneMap) logger.warn('Website hero video is HDR but this ffmpeg lacks zscale/tonemap; the copy is not tone-mapped');
    await video.transcode(file.path, tmpOut, { remux, toneMap, duration });
    const key = `website/${publicId}/video.mp4`;
    await getStorage().putFromFile(key, tmpOut, { contentType: 'video/mp4' });
    const stat = await fs.stat(tmpOut);
    return insertAsset({
      public_id: publicId,
      kind: 'video',
      mime_type: 'video/mp4',
      width: probed.width || null,
      height: probed.height || null,
      rendition_keys: JSON.stringify({ video: key }),
      original_filename: String(file.originalname || '').slice(0, 255),
      size_bytes: stat.size,
      created_by: adminId,
    });
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError('The video could not be processed', 400, 'WEBSITE_ASSET_UNREADABLE');
  } finally {
    await fs.unlink(tmpOut).catch(() => {});
  }
}

async function removeKeys(keys) {
  const storage = getStorage();
  for (const key of Object.values(keys)) {
    // eslint-disable-next-line no-await-in-loop -- a handful of keys
    await storage.delete(key).catch(() => {});
  }
}

/** Whether a stored document (draft or published) still uses the asset. */
async function isAssetInUse(publicId) {
  const rows = await db('website_documents').select('state', 'document');
  return rows.filter((row) => row.document.includes(`"id":"${publicId}"`)).map((row) => row.state);
}

async function deleteAsset(publicId) {
  const row = await db('website_assets').where({ public_id: publicId }).first();
  if (!row) throw new AppError('Upload not found', 404, 'WEBSITE_ASSET_NOT_FOUND');
  const usedBy = await isAssetInUse(publicId);
  if (usedBy.length) {
    const err = new AppError('The image is still used on the website. Remove it from the page first.', 409, 'WEBSITE_ASSET_IN_USE');
    err.details = { usedBy };
    throw err;
  }
  await db('website_assets').where({ id: row.id }).del();
  await removeKeys(parseRenditionKeys(row));
}

module.exports = { listAssets, createImageAsset, createVideoAsset, deleteAsset, publicAsset, IMAGE_TYPES };
