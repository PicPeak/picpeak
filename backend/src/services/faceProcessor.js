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

const { db } = require('../database/db');
const logger = require('../utils/logger');
const { getStorage } = require('./storage');
const { ensurePreviewImage } = require('./imageProcessor');
// SidecarUnavailableError is deliberately NOT caught here — it propagates to
// faceQueue, which is the only layer that knows to retry rather than fail.
const { detectFaces } = require('./faceClient');
const { assignFaces, packEmbedding } = require('./faceClustering');
const { getThresholds, isEnabledForEvent } = require('./faceSettings');

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

  const thresholds = await getThresholds();

  await db.transaction(async (trx) => {
    // Replace rather than append: a re-scan of the same photo must not
    // double its faces. Detaching first keeps the FK to event_people clean.
    await trx('photo_faces').where({ photo_id: photoId }).del();

    const inserted = [];
    for (const face of faces) {
      const [bx, by, bw, bh] = face.bbox || [0, 0, 0, 0];
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

    if (inserted.length) {
      await assignFaces(photo.event_id, inserted, { thresholds, trx });
    }

    await trx('photos').where({ id: photoId }).update({
      face_status: 'done',
      face_count: faces.length,
      face_started_at: null,
      face_error: null,
    });
  });

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

module.exports = { processPhotoFaces, enqueueEvent, purgeEvent };
