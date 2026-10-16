/**
 * Per-photo scene tagging (issue 1733).
 *
 * Runs on the stored THUMBNAIL. The model looks at a 224px image, every
 * processed photo already has a thumbnail in managed storage (external
 * photos included), and no preview tier has to be generated for a backfill.
 *
 * What that costs: with the default thumbnail settings (300x300, fit
 * "cover") the model sees the centre square of the frame, not all of it.
 */

const { db } = require('../database/db');
const { livePhotos } = require('../utils/photoVisibility');
const logger = require('../utils/logger');
const { getStorage } = require('./storage');
const { ensureThumbnail } = require('./imageProcessor');
// SidecarUnavailableError is deliberately NOT caught here: it propagates to
// tagQueue, which is the only layer that knows to retry rather than fail.
const { tagImage } = require('./faceClient');
const { isEnabledForEvent } = require('./tagSettings');
const { isStorageUnavailableError } = require('./storage/storageErrors');
const { isTransient } = require('./imageResourcePolicy');

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

/**
 * No thumbnail could be made because the photo's external source (a NAS
 * mount) is not there. Says nothing about the photo: tagQueue keeps the row
 * claimed and the janitor returns it, as faceQueue does for the same outage.
 */
class TagSourceUnreachableError extends Error {
  constructor(photoId, reason) {
    super(`Tagging of photo ${photoId} deferred: ${reason}`);
    this.name = 'TagSourceUnreachableError';
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
 * The row as long as it still belongs to this claim. `tag_attempt_id` is
 * written by the claim and cleared by everything that takes the row away
 * (delete, replacement, re-queue, janitor), so a second claim of the same
 * photo never matches the first one's guard.
 */
function claimGuard(claimed, conn = db) {
  return conn('photos').where({
    id: claimed.id, tag_status: 'processing', tag_attempt_id: claimed.tag_attempt_id,
  });
}

/**
 * Close a claimed row. A row that was deleted, re-queued, reset or claimed
 * again meanwhile is left alone.
 */
function settle(claimed, status, error = null) {
  return claimGuard(claimed)
    .update({ tag_status: status, tag_started_at: null, tag_attempt_id: null, tag_error: error });
}

/**
 * Tag one claimed photo (the row tagQueue.claimNextPhoto returned). Returns
 * `{ status }`: done | skipped | failed, or requeued when the gallery was
 * archived under the claim.
 *
 * Throws SidecarUnavailableError when the sidecar is down and a storage
 * error when the backend is unreachable; the caller returns the row to
 * 'pending' for both rather than failing it.
 */
async function processPhotoTags(claimed) {
  const photoId = claimed.id;
  // Read under the claim: a replacement between the claim and here already
  // took the row away, and its new file is the next claim's to tag.
  const photo = await claimGuard(claimed).first();
  if (!photo) return { status: 'skipped' };

  const event = await db('events').where({ id: photo.event_id }).first();
  if (!(await isEnabledForEvent(event))) {
    // Switched off between enqueue and claim. Not an error.
    await settle(claimed, 'skipped');
    return { status: 'skipped' };
  }

  const isVideo = photo.media_type === 'video'
    || (photo.mime_type && photo.mime_type.startsWith('video/'));
  if (isVideo) {
    await settle(claimed, 'skipped');
    return { status: 'skipped' };
  }

  let buffer = null;
  let thumbnailError = null;
  try {
    const thumbnailKey = await ensureThumbnail(photo);
    if (thumbnailKey) buffer = await streamToBuffer(await getStorage().get(thumbnailKey));
  } catch (err) {
    // The two "not now" kinds tagQueue already knows what to do with.
    if (isStorageUnavailableError(err) || isTransient(err)) throw err;
    thumbnailError = err;
  }
  if (!buffer) {
    // No thumbnail, by a null or by an error. That fails the photo only when
    // it is the photo's fault, and the image pipeline reports three outages
    // the same way as a broken file. A failed row is not retried, so each is
    // ruled out first.
    //
    // 1. Storage: generateThumbnail logs a failed upload and answers null.
    //    Asking the backend anything throws while it is away.
    await getStorage().stat(photo.thumbnail_path || `thumbnails/thumb_${photo.filename}`).catch((err) => {
      if (isStorageUnavailableError(err)) throw err;
    });
    // 2. An external source whose mount is not attached.
    const unreachable = await require('./faceProcessor').externalSourceUnreachable(photo);
    if (unreachable) throw new TagSourceUnreachableError(photoId, unreachable);
    // 3. The gallery was archived after this claim: its files are in the
    //    archive now. Back to the queue, which leaves archived galleries
    //    alone until they are restored.
    const { is_archived: archived } = (await db('events').where({ id: photo.event_id }).first('is_archived')) || {};
    if (archived === true || archived === 1) {
      await claimGuard(claimed).update({ tag_status: 'pending', tag_started_at: null, tag_attempt_id: null });
      return { status: 'requeued' };
    }

    if (thumbnailError) throw thumbnailError;
    await settle(claimed, 'failed', 'No thumbnail to tag');
    return { status: 'failed' };
  }

  const result = await tagImage(buffer, photo.filename || 'photo.jpg');
  const tags = sanitizeTags(result?.tags);

  try {
    await db.transaction(async (trx) => {
      // The claim first: it locks the row, and when the photo was deleted,
      // replaced or re-queued while the sidecar was working nothing is
      // written at all, instead of tags for a different picture (or, on
      // PostgreSQL, a foreign-key error for a photo that is gone).
      //
      // The event row before that, when there are tags to insert (issue
      // 2108): their foreign key takes a key-share lock on it, and a capped
      // trash restore, an archive delete or a rename holds it FOR UPDATE
      // before it touches the photo. Taken after the photo, that is a lock
      // cycle. The same lock, only earlier; no tags, no event lock.
      if (tags.length && trx.client.config.client === 'pg') {
        await trx('events').where({ id: photo.event_id }).forKeyShare().first('id');
      }
      const committed = await claimGuard(claimed, trx)
        .update({ tag_status: 'done', tag_started_at: null, tag_attempt_id: null, tag_error: null });
      if (committed === 0) throw new StaleTagScanError(photoId);
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
    // 'processing' too: a worker that read the switch as off a moment ago is
    // about to settle its claim as 'skipped', after this backfill has been
    // and gone. Re-queued, that claim is void (its id is cleared) and the
    // photo is scanned under the new switch; at worst a scan runs twice.
    query.where(function () {
      this.whereNull('tag_status').orWhereIn('tag_status', ['failed', 'skipped', 'processing']);
    });
  }

  const updated = await query.update({
    tag_status: 'pending', tag_started_at: null, tag_attempt_id: null, tag_error: null,
  });
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
    .update({ tag_status: null, tag_started_at: null, tag_attempt_id: null, tag_error: null });
  return trx('photo_tags').where({ photo_id: photoId }).del();
}

/** Queue progress for the admin card. */
async function getTagStatus(eventId) {
  const rows = await livePhotos(db)
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
  processPhotoTags, claimGuard, enqueueEvent, purgePhotoTags, getTagStatus, sanitizeTags,
  TagSourceUnreachableError,
};
