/**
 * Per-photo face detection (#1074).
 *
 * Runs on the PREVIEW rendition, not the original. A 1920px JPEG is ~40x
 * cheaper to decode than a 45MP original and costs nothing in recall at the
 * face sizes an event gallery actually contains.
 *
 * Note the side effect that has: on an install with `lightbox_preview_enabled`
 * off, no previews exist, so a face backfill generates the whole preview tier
 * as it goes — a real Sharp workload and real disk. That is why the admin
 * toggle warns about it and why the face queue defaults to concurrency 1.
 */

const sharp = require('sharp');
const { db } = require('../database/db');
const logger = require('../utils/logger');
const { getStorage } = require('./storage');
const { ensurePreviewImage } = require('./imageProcessor');
// SidecarUnavailableError is deliberately NOT caught here — it propagates to
// faceQueue, which is the only layer that knows to retry rather than fail.
const { detectFaces } = require('./faceClient');
const { assignFaces, packEmbedding, recomputeCentroid } = require('./faceClustering');
const { getThresholds, isEnabledForEvent } = require('./faceSettings');

/**
 * Thrown when a scan finishes but the photo is no longer the row we claimed —
 * the event was purged, archived or re-queued mid-flight. Not a failure of
 * the photo, so the queue must not mark it 'failed'.
 */
class StaleScanError extends Error {
  constructor(photoId) {
    super(`Face scan for photo ${photoId} was superseded`);
    this.name = 'StaleScanError';
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

/**
 * Detect and cluster the faces in one photo.
 *
 * Throws SidecarUnavailableError when the sidecar is down — the caller must
 * return the row to 'pending' rather than failing it.
 */
async function processPhotoFaces(photoId) {
  const photo = await db('photos').where({ id: photoId }).first();
  if (!photo) {
    logger.warn(`faceProcessor: photo ${photoId} disappeared before processing`);
    return { status: 'skipped' };
  }

  const event = await db('events').where({ id: photo.event_id }).first();
  if (!(await isEnabledForEvent(event))) {
    // The toggle was switched off between enqueue and claim. Not an error.
    await db('photos').where({ id: photoId }).update({
      face_status: 'skipped', face_started_at: null, face_error: null,
    });
    return { status: 'skipped' };
  }

  // Videos have no preview tier and no meaningful single frame to scan.
  const isVideo = photo.media_type === 'video'
    || (photo.mime_type && photo.mime_type.startsWith('video/'));
  if (isVideo) {
    await db('photos').where({ id: photoId }).update({
      face_status: 'skipped', face_started_at: null, face_count: 0,
    });
    return { status: 'skipped' };
  }

  // No external/reference guard here on purpose (#1090). One used to skip
  // them, because resolvePhotoStorageKey returns null for photos outside
  // managed storage and ensurePreviewImage could not build a preview. #1078
  // removed that limitation: ensurePreviewImage now reads externals straight
  // off the mount via resolvePhotoFilePath and writes the preview into
  // managed storage, so the key below is readable like any other. Keeping the
  // guard made the whole feature a no-op on external-media installs, where
  // every photo in the library can be external.
  //
  // A photo whose source really is gone still returns null and lands in the
  // 'failed' branch below, which is the honest outcome — that is a broken
  // photo, not an unsupported one.
  const previewKey = await ensurePreviewImage(photo);
  if (!previewKey) {
    // No preview and no way to make one — the source is missing or corrupt.
    // That is a property of this photo, so it fails rather than retries.
    await db('photos').where({ id: photoId }).update({
      face_status: 'failed',
      face_started_at: null,
      face_error: 'Could not generate a preview rendition to scan',
    });
    return { status: 'failed' };
  }

  const storage = getStorage();
  const buffer = await streamToBuffer(await storage.get(previewKey));

  // Throws SidecarUnavailableError upward on a down sidecar — deliberately
  // not caught here, so the queue can distinguish "retry" from "failed".
  const result = await detectFaces(buffer, photo.filename || 'photo.jpg');
  const faces = result?.faces || [];
  const modelVersion = result?.model_version || null;

  // Bounding boxes come back in the pixel space of the image the SIDECAR was
  // given — which is the preview (≤1920px long edge), not the original. Every
  // consumer compares them against photos.width/height, which are the
  // ORIGINAL dimensions: the strip's avatar crop works in ratios of them, and
  // the auto-category portrait rule divides face area by frame area.
  //
  // Left unscaled, a 6000px photo yields boxes ~3x too small (and areas ~9x
  // too small), so avatars crop to the wrong place and "Portraits" never
  // fires. It is invisible on any photo already under 1920px, which is why
  // the demo gallery looked correct.
  //
  // Scale here, once, so everything downstream can assume original-image
  // coordinates.
  let boxScale = 1;
  try {
    const previewMeta = await sharp(buffer).metadata();
    if (previewMeta?.width && photo.width) {
      boxScale = photo.width / previewMeta.width;
    }
  } catch (err) {
    logger.warn(`faceProcessor: could not read preview dimensions for photo ${photoId}`, {
      error: err.message,
    });
  }

  const thresholds = await getThresholds();

  try {
    await db.transaction(async (trx) => {
    // Replace rather than append: a re-scan of the same photo must not
    // double its faces. Detaching first keeps the FK to event_people clean.
    //
    // Remember which people the OLD faces belonged to. Deleting the rows does
    // not undo their contribution to event_people.face_count_total or to the
    // running-mean centroid, so without recomputing those afterwards a
    // re-scan inflates every count (typically doubling it) and leaves ghost
    // people behind when a face is no longer detected.
      const affectedPeople = await trx('photo_faces')
        .where({ photo_id: photoId })
        .whereNotNull('person_id')
        .distinct('person_id')
        .pluck('person_id');

      await trx('photo_faces').where({ photo_id: photoId }).del();

      const inserted = [];
      for (const face of faces) {
        const [bx, by, bw, bh] = (face.bbox || [0, 0, 0, 0]).map((v) => v * boxScale);
        const row = {
          photo_id: photoId,
          event_id: photo.event_id,
          bbox_x: bx, bbox_y: by, bbox_w: bw, bbox_h: bh,
          det_score: face.score ?? null,
          yaw: face.yaw ?? null,
          pitch: face.pitch ?? null,
          blur: face.blur ?? null,
          embedding: face.embedding ? packEmbedding(face.embedding) : null,
          model_version: modelVersion,
          // ISO string, not a Date — under Jest a Date handed to the sqlite3
          // binding stores as the literal "[object Object]" (see CLAUDE.md).
          created_at: new Date().toISOString(),
        };
        const [id] = await trx('photo_faces').insert(row).returning('id');
        inserted.push({ ...row, id: typeof id === 'object' ? id.id : id });
      }

      // Rebuild the people the removed faces belonged to BEFORE assigning the
      // replacements, so assignment compares against honest centroids.
      for (const personId of affectedPeople) {
        await recomputeCentroid(personId, trx);
      }

      if (inserted.length) {
        await assignFaces(photo.event_id, inserted, { thresholds, trx });
      }

      // Commit the photo only if it is STILL the row we claimed. An admin who
      // purges or archives the event while this worker was waiting on the
      // sidecar has already cleared face_status; without this guard the worker
      // would write its rows back moments after "all face data deleted"
      // reported success, so an erasure request would silently not stick.
      const committed = await trx('photos')
        .where({ id: photoId, face_status: 'processing' })
        .update({
          face_status: 'done',
          face_count: faces.length,
          face_started_at: null,
          face_error: null,
        });

      if (committed === 0) {
        logger.info(
          `faceProcessor: photo ${photoId} was purged or re-queued while scanning — discarding results`
        );
        // Undo this transaction's inserts rather than leaving orphans behind.
        throw new StaleScanError(photoId);
      }
    });
  } catch (err) {
    // Losing a race with a purge is an expected outcome, not a photo that
    // failed to scan. The transaction has already rolled back, so nothing was
    // written; leave face_status exactly as the purge left it.
    if (err instanceof StaleScanError) return { status: 'skipped' };
    throw err;
  }

  // Auto-categories (#1074 phase 3) run as a distinct step AFTER detection,
  // outside the transaction: they are a convenience, and a rule-engine
  // failure must never roll back the faces we just paid the sidecar for.
  // No-ops unless separately enabled.
  try {
    const { categorizeEvent } = require('./faceAutoCategories');
    await categorizeEvent(photo.event_id);
  } catch (err) {
    logger.warn(`faceProcessor: auto-categorisation failed for event ${photo.event_id}`, {
      error: err.message,
    });
  }

  return { status: 'done', faceCount: faces.length };
}

/**
 * Queue every eligible photo in an event for (re-)scanning.
 *
 * `onlyUnscanned` is the backfill case — enabling the toggle on a gallery
 * that already has photos. Without it, this is a full re-scan.
 */
async function enqueueEvent(eventId, { onlyUnscanned = false } = {}) {
  const query = db('photos')
    .where({ event_id: eventId })
    // Photos still being processed have no preview and no dimensions yet;
    // photoProcessor enqueues them itself on completion.
    .where(function () {
      this.where('processing_status', 'complete').orWhereNull('processing_status');
    });

  if (onlyUnscanned) {
    query.where(function () {
      this.whereNull('face_status').orWhereIn('face_status', ['failed', 'skipped']);
    });
  }

  const updated = await query.update({
    face_status: 'pending',
    face_started_at: null,
    face_error: null,
  });

  logger.info(`faceProcessor: queued ${updated} photo(s) for face detection in event ${eventId}`);
  return updated;
}

/**
 * Remove every face row for an event. Used by "delete all face data", by the
 * per-event toggle going off, and by archival.
 */
async function purgeEvent(eventId) {
  return db.transaction(async (trx) => {
    // Detach before deleting people so the SET NULL FK never fires against
    // rows that are about to go anyway.
    await trx('photo_faces').where({ event_id: eventId }).update({ person_id: null });
    const faces = await trx('photo_faces').where({ event_id: eventId }).del();
    const people = await trx('event_people').where({ event_id: eventId }).del();
    await trx('photos').where({ event_id: eventId }).update({
      face_status: null, face_count: null, face_started_at: null, face_error: null,
    });
    logger.info(`faceProcessor: purged ${faces} face(s) and ${people} person(s) from event ${eventId}`);
    return { faces, people };
  });
}

/**
 * Remove the face rows belonging to one photo, and rebuild the people that
 * lose members as a result.
 *
 * Called from every photo-deletion path. The schema declares ON DELETE
 * CASCADE, but SQLite only enforces foreign keys when `PRAGMA foreign_keys`
 * is on and PicPeak does not enable it globally — so on SQLite the cascade
 * never fires and biometric embeddings would outlive the photo. Even where it
 * does fire (Postgres), the cascade cannot fix up event_people counts or
 * centroids, which is the other half of this.
 *
 * Safe to call for photos that were never scanned: it simply deletes nothing.
 */
async function purgePhotoFaces(photoId, trx = db) {
  const affected = await trx('photo_faces')
    .where({ photo_id: photoId })
    .whereNotNull('person_id')
    .distinct('person_id')
    .pluck('person_id');

  // Drop any in-flight claim as well. A worker holding this photo would
  // otherwise still satisfy its `face_status = 'processing'` commit guard and
  // write fresh faces straight after the purge — and with FK enforcement off
  // on SQLite, the subsequent photo delete cannot cascade them away, leaving
  // orphaned biometric rows.
  await trx('photos').where({ id: photoId }).update({
    face_status: null, face_count: null, face_started_at: null, face_error: null,
  });

  const removed = await trx('photo_faces').where({ photo_id: photoId }).del();
  if (!removed) return { removed: 0 };

  const { recomputeCentroid: recompute } = require('./faceClustering');
  for (const personId of affected) {
    // Deletes the person outright when it has no members left.
    await recompute(personId, trx);
  }
  return { removed, peopleTouched: affected.length };
}

module.exports = {
  processPhotoFaces, enqueueEvent, purgeEvent, purgePhotoFaces, StaleScanError,
};
