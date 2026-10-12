/**
 * Per-photo scene tagging (issue 1733).
 *
 * Runs on the stored THUMBNAIL. The model looks at a 224px image, so a
 * thumbnail loses nothing, every processed photo already has one in managed
 * storage (external photos included), and no preview tier has to be
 * generated for a backfill.
 */

const { db } = require('../database/db');
const logger = require('../utils/logger');
const { getStorage } = require('./storage');
const { ensureThumbnail } = require('./imageProcessor');
// SidecarUnavailableError is deliberately NOT caught here: it propagates to
// tagQueue, which is the only layer that knows to retry rather than fail.
const { tagImage } = require('./faceClient');
const { isEnabledForEvent } = require('./tagSettings');

// The sidecar answers with keys from its fixed vocabulary. Anything else is
// dropped rather than stored: the key ends up in a guest payload and in a
// translation lookup.
const TAG_KEY = /^[a-z][a-z_]{1,63}$/;
const MAX_TAGS_PER_PHOTO = 10;

/** The scan finished, but the row is no longer the one this worker claimed. */
class StaleTagScanError extends Error {
  constructor(photoId) {
    super(`Tagging of photo ${photoId} was superseded`);
    this.name = 'StaleTagScanError';
  }
}

async function streamToBuffer(stream) {
  if (Buffer.isBuffer(stream)) return stream;
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/** Valid, de-duplicated `{ tag, score }` pairs from a sidecar response. */
function sanitizeTags(raw) {
  const seen = new Set();
  const out = [];
  for (const entry of Array.isArray(raw) ? raw : []) {
    const tag = entry?.tag;
    const score = Number(entry?.score);
    if (typeof tag !== 'string' || !TAG_KEY.test(tag) || seen.has(tag)) continue;
    if (!Number.isFinite(score)) continue;
    seen.add(tag);
    out.push({ tag, score: Math.min(1, Math.max(0, score)) });
    if (out.length >= MAX_TAGS_PER_PHOTO) break;
  }
  return out;
}

/**
 * Close a claimed row. Guarded on 'processing', the state this worker put it
 * in: a row that was deleted, re-queued or reset meanwhile is left alone.
 */
function settle(photoId, status, error = null) {
  return db('photos')
    .where({ id: photoId, tag_status: 'processing' })
    .update({ tag_status: status, tag_started_at: null, tag_error: error });
}

/**
 * Tag one claimed photo. Returns `{ status }`: done | skipped | failed.
 *
 * Throws SidecarUnavailableError when the sidecar is down and a storage
 * error when the backend is unreachable; the caller returns the row to
 * 'pending' for both rather than failing it.
 */
async function processPhotoTags(photoId) {
  const photo = await db('photos').where({ id: photoId }).first();
  if (!photo) return { status: 'skipped' };

  const event = await db('events').where({ id: photo.event_id }).first();
  if (!(await isEnabledForEvent(event))) {
    // Switched off between enqueue and claim. Not an error.
    await settle(photoId, 'skipped');
    return { status: 'skipped' };
  }

  const isVideo = photo.media_type === 'video'
    || (photo.mime_type && photo.mime_type.startsWith('video/'));
  if (isVideo) {
    await settle(photoId, 'skipped');
    return { status: 'skipped' };
  }

  const thumbnailKey = await ensureThumbnail(photo);
  if (!thumbnailKey) {
    await settle(photoId, 'failed', 'No thumbnail to tag');
    return { status: 'failed' };
  }
  const buffer = await streamToBuffer(await getStorage().get(thumbnailKey));

  const result = await tagImage(buffer, photo.filename || 'photo.jpg');
  const tags = sanitizeTags(result?.tags);

  try {
    await db.transaction(async (trx) => {
      // Replace rather than append: a re-run must not keep a tag the model
      // no longer reports.
      await trx('photo_tags').where({ photo_id: photoId }).del();
      if (tags.length) {
        const createdAt = new Date().toISOString();
        await trx('photo_tags').insert(tags.map((t) => ({
          photo_id: photoId,
          event_id: photo.event_id,
          tag: t.tag,
          score: t.score,
          created_at: createdAt,
        })));
      }
      const committed = await trx('photos')
        .where({ id: photoId, tag_status: 'processing' })
        .update({ tag_status: 'done', tag_started_at: null, tag_error: null });
      // Deleted, replaced or re-queued while the sidecar was working: roll
      // the rows back instead of attaching them to a different picture.
      if (committed === 0) throw new StaleTagScanError(photoId);
    });
  } catch (err) {
    if (err instanceof StaleTagScanError) return { status: 'skipped' };
    throw err;
  }

  return { status: 'done', tagCount: tags.length };
}

/**
 * Queue an event's photos. `onlyUntagged` is the backfill when the switch
 * goes on; without it this is a full re-run.
 */
async function enqueueEvent(eventId, { onlyUntagged = false } = {}) {
  const query = db('photos')
    .where({ event_id: eventId })
    // Photos still in the upload pipeline are queued by photoProcessor.
    .where(function () {
      this.where('processing_status', 'complete').orWhereNull('processing_status');
    });

  if (onlyUntagged) {
    query.where(function () {
      this.whereNull('tag_status').orWhereIn('tag_status', ['failed', 'skipped']);
    });
  }

  const updated = await query.update({ tag_status: 'pending', tag_started_at: null, tag_error: null });
  logger.info(`tagProcessor: queued ${updated} photo(s) for tagging in event ${eventId}`);
  return updated;
}

/**
 * Remove one photo's tags and drop any claim on it.
 *
 * Called from the photo-deletion paths: the FK declares ON DELETE CASCADE,
 * but PicPeak does not enable foreign keys on SQLite, so the cascade never
 * fires there.
 */
async function purgePhotoTags(photoId, trx = db) {
  await trx('photos').where({ id: photoId })
    .update({ tag_status: null, tag_started_at: null, tag_error: null });
  return trx('photo_tags').where({ photo_id: photoId }).del();
}

/** Queue progress for the admin card. */
async function getTagStatus(eventId) {
  const rows = await db('photos')
    .where({ event_id: eventId })
    .whereNotNull('tag_status')
    .groupBy('tag_status')
    .select('tag_status')
    .count({ c: '*' });
  const by = Object.fromEntries(rows.map((r) => [r.tag_status, Number(r.c) || 0]));
  const pending = (by.pending || 0) + (by.processing || 0);
  return {
    tagged: by.done || 0,
    total: Object.values(by).reduce((a, b) => a + b, 0),
    pending,
    failed: by.failed || 0,
    skipped: by.skipped || 0,
    in_progress: pending > 0,
  };
}

module.exports = {
  processPhotoTags, enqueueEvent, purgePhotoTags, getTagStatus, sanitizeTags,
};
