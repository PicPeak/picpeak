/**
 * The photo trash (issue 1733, item D2; migration 294).
 *
 * A photo an admin deletes is flagged, not moved: its row, file, thumbnails
 * and child rows stay where they are, and every reader that shows photos
 * skips a flagged row (utils/photoVisibility.js livePhotos). Three states,
 * each entered by one guarded UPDATE, so two requests or two replicas never
 * both act on a photo:
 *
 *   in the gallery   deleted_at NULL
 *   in the trash     deleted_at set, purge_after set     (restorable)
 *   being purged     deleted_at set, purge_after NULL    (one way)
 *
 * A purge claims the photo first and only then runs the hard delete an admin
 * delete was before the trash (deletePhotoForGood: files, then the row). A
 * restore racing it changes no row and reports the photo as gone. A purge
 * that died after its claim is claimed again by the sweep once it is stale;
 * the claim time is kept in deleted_at, which has no other reader by then.
 */

const { db } = require('../database/db');
const logger = require('../utils/logger');
const { scheduledTask } = require('./scheduledTask');
const { getStorage } = require('./storage');
const { photoCapOf, countEventPhotos } = require('./photoCap');
const { decodeSettingValue } = require('./eventSettings');

const SETTING_KEY = 'general_photo_trash_retention_days';
const DEFAULT_RETENTION_DAYS = 30;
const MAX_RETENTION_DAYS = 365;
const DAY_MS = 24 * 60 * 60 * 1000;
// A purge claim older than this was left by a crash.
const STALE_PURGE_MS = 15 * 60 * 1000;
const SWEEP_BATCH = 200;

const iso = (value) => (value == null ? null : new Date(value).toISOString());

/** Days a deleted photo stays restorable; 0 deletes at once, as before the trash. */
async function getRetentionDays() {
  try {
    const row = await db('app_settings').where({ setting_key: SETTING_KEY }).first();
    const value = row ? decodeSettingValue(row.setting_value) : null;
    const days = Number(value);
    if (value === null || value === '' || !Number.isInteger(days) || days < 0) return DEFAULT_RETENTION_DAYS;
    return Math.min(days, MAX_RETENTION_DAYS);
  } catch (error) {
    // Unknown is not "0": keep what was deleted.
    logger.error('Failed to read the photo trash retention setting:', error.message);
    return DEFAULT_RETENTION_DAYS;
  }
}

/**
 * Move one photo of the gallery to the trash. False when it was not in the
 * gallery any more (already trashed or deleted by another request).
 */
async function trashPhoto(photo, adminId, retentionDays, now = Date.now()) {
  const updated = await db('photos')
    .where({ id: photo.id, event_id: photo.event_id })
    .whereNull('deleted_at')
    .update({
      deleted_at: new Date(now).toISOString(),
      purge_after: new Date(now + retentionDays * DAY_MS).toISOString(),
      deleted_by_admin_id: adminId ?? null,
    });
  return updated === 1;
}

/** The gallery's trash, newest first. Photos being purged are not in it. */
async function listTrash(eventId) {
  const rows = await db('photos')
    .leftJoin('admin_users', 'admin_users.id', 'photos.deleted_by_admin_id')
    .where('photos.event_id', eventId)
    .whereNotNull('photos.deleted_at')
    .whereNotNull('photos.purge_after')
    .orderBy('photos.deleted_at', 'desc')
    .orderBy('photos.id', 'desc')
    .select('photos.id', 'photos.filename', 'photos.media_type', 'photos.size_bytes', 'photos.deleted_at',
      'photos.purge_after', 'photos.thumbnail_path', 'photos.moderation_status',
      'admin_users.username as deleted_by_name');
  return rows.map((row) => ({
    id: Number(row.id),
    filename: row.filename,
    media_type: row.media_type || 'image',
    size_bytes: Number(row.size_bytes) || 0,
    deleted_at: iso(row.deleted_at),
    purge_after: iso(row.purge_after),
    deleted_by_name: row.deleted_by_name || null,
    // Held for review when it was trashed: it comes back held.
    held: row.moderation_status != null,
    thumbnail_url: row.thumbnail_path ? `/admin/events/${eventId}/photos/trash/${row.id}/thumbnail` : null,
  }));
}

/** A photo in the gallery's trash, or undefined. */
function findTrashed(eventId, photoId) {
  return db('photos')
    .where({ id: photoId, event_id: eventId })
    .whereNotNull('deleted_at')
    .whereNotNull('purge_after')
    .first();
}

/**
 * Put photos back into the gallery. One transaction that holds the event
 * row, like an upload's cap check (photoCap.insertPhotoWithinCap), so
 * restores and uploads cannot pass the cap together.
 */
async function restorePhotos(event, photoIds) {
  const cap = photoCapOf(event);
  const result = await db.transaction(async (trx) => {
    if (cap && trx.client.config.client === 'pg') await trx('events').where({ id: event.id }).forUpdate().first();
    let live = cap ? await countEventPhotos(event.id, trx) : 0;
    const restored = [];
    const failed = [];
    for (const id of photoIds) {
      if (cap && live >= cap) {
        failed.push({ id, code: 'PHOTO_CAP_REACHED' });
        continue;
      }
      const updated = await trx('photos')
        .where({ id, event_id: event.id })
        .whereNotNull('deleted_at')
        .whereNotNull('purge_after')
        .update({ deleted_at: null, purge_after: null, deleted_by_admin_id: null });
      if (updated === 1) {
        restored.push(id);
        live += 1;
      } else {
        failed.push({ id, code: 'NOT_IN_TRASH' });
      }
    }
    return { restored, failed };
  });
  // A transfer holding a restored photo may have held its ready mail back
  // while it had nothing to hand out (issue 2061).
  try {
    await require('./transferService').sendHeldReadyEmailsForPhotos(result.restored);
  } catch (err) {
    logger.warn('photoTrash: held transfer email failed', { error: err.message });
  }
  return result;
}

/**
 * Delete a photo outright: its files, its face data, its row. What an admin
 * delete did before the trash, and still does with a retention of 0; a
 * purge runs it on a photo it has claimed. Every step tolerates being run
 * twice.
 *
 * `strict` (every purge): an original that cannot be deleted stops here and
 * the row stays, claimed, for the sweep to try again. Deleting the row over a
 * file that is still there would let the S3 importer or the folder watcher
 * bring the photo back as a new one.
 */
async function deletePhotoForGood(event, photo, { strict = false } = {}) {
  const storage = getStorage();
  const { resolvePhotoStorageKey } = require('./photoResolver');
  const imageProcessor = require('./imageProcessor');

  try {
    const originalKey = resolvePhotoStorageKey(event, photo);
    if (originalKey) await storage.delete(originalKey);
  } catch (error) {
    logger.error('Error deleting photo file:', error);
    if (strict) throw error;
  }
  // Derived files; thumbnail_path and friends are canonical storage keys.
  for (const key of [photo.thumbnail_path, photo.hero_path, photo.preview_path, photo.web_path]) {
    if (key) await storage.delete(key).catch((error) => logger.error('Error deleting a derived photo file:', error));
  }
  // Responsive tiers exist independently of the canonical renditions (#1095).
  await imageProcessor.deletePreviewTiers(photo);
  await imageProcessor.deleteThumbnailTiers(photo);
  if (photo.watermark_path) await require('./watermarkService').deleteWatermarkFile(photo.watermark_path);

  // Face data (#1074): the FK cascade is inert on SQLite, and cannot fix up
  // event_people counts anyway. See faceProcessor.purgePhotoFaces.
  try {
    await require('./faceProcessor').purgePhotoFaces(photo.id);
  } catch (err) {
    logger.warn(`deletePhoto: face purge failed for photo ${photo.id}`, { error: err.message });
  }

  // An external photo's file stays on the NAS; make sure the folder watcher
  // (issue 1187) does not re-import it on its next pass.
  await require('./externalImportService').recordExclusions(Number(photo.event_id), [photo]);
  // Adaptive streaming ladder (issue 1733): derived as well. Its state is
  // read again, the row in hand may be weeks old by the time a purge runs;
  // removed after the row, so a transcode still running cannot publish one
  // behind this.
  const ladder = await db('photos').where({ id: photo.id, event_id: photo.event_id }).first('id', 'hls_status', 'hls_path');
  // Scene tags (issue 1733) go with the row in one transaction: the cascade
  // is inert on SQLite, and a tagging result in flight then lands either
  // before this (and is deleted here) or after it (and finds no row). The
  // row first, the order tagProcessor locks in.
  await db.transaction(async (trx) => {
    await require('./heroPhotoLock').lockHeroEvents(trx, [photo.id]);
    await trx('photos').where({ id: photo.id, event_id: photo.event_id }).delete();
    await trx('photo_tags').where({ photo_id: photo.id }).del();
  });
  await require('./videoHlsService').deleteLadder(ladder);
}

/**
 * Delete a trashed photo for good. The claim decides: false when another
 * request restored or claimed it first, and nothing is touched then.
 * `due` limits the claim to a photo whose retention has run out (the sweep).
 */
async function purgePhoto(event, photo, { due = null, now = Date.now() } = {}) {
  let claim = db('photos')
    .where({ id: photo.id, event_id: photo.event_id })
    .whereNotNull('deleted_at')
    .whereNotNull('purge_after');
  if (due) claim = claim.where('purge_after', '<=', due);
  if (await claim.update({ purge_after: null, deleted_at: new Date(now).toISOString() }) !== 1) return false;
  await deletePhotoForGood(event, photo, { strict: true });
  return true;
}

/**
 * Empty a gallery's trash, whatever is left of its retention (archiving).
 * A photo another process is purging right now is deleted here as well;
 * the steps are the same and tolerate each other.
 */
async function purgeEventTrash(event) {
  const rows = await db('photos').where({ event_id: event.id }).whereNotNull('deleted_at');
  for (const photo of rows) {
    if (photo.purge_after == null) await deletePhotoForGood(event, photo, { strict: true });
    else await purgePhoto(event, photo);
  }
  return rows.length;
}

/**
 * The hourly sweep: purge what is past its retention, and finish the purges
 * a crash interrupted. Safe on several replicas at once, each photo is
 * claimed by one of them.
 */
async function purgeExpired(now = Date.now()) {
  const nowIso = new Date(now).toISOString();
  const staleIso = new Date(now - STALE_PURGE_MS).toISOString();
  const events = new Map();
  const eventOf = async (eventId) => {
    if (!events.has(eventId)) events.set(eventId, await db('events').where({ id: eventId }).first());
    return events.get(eventId);
  };
  let purged = 0;

  const run = async (candidates, claimAndDelete) => {
    const skipped = [];
    for (;;) {
      const rows = await candidates().whereNotIn('id', skipped).orderBy('id').limit(SWEEP_BATCH);
      if (rows.length === 0) return;
      for (const photo of rows) {
        try {
          const event = await eventOf(photo.event_id);
          if (event && await claimAndDelete(event, photo)) purged += 1;
          else skipped.push(photo.id);
        } catch (error) {
          skipped.push(photo.id);
          logger.error(`Photo trash: could not purge photo ${photo.id}`, { error: error.message });
        }
      }
      // SQLite's bound-parameter cap; the rest waits for the next run.
      if (skipped.length > 500) return;
    }
  };

  await run(
    () => db('photos').whereNotNull('deleted_at').whereNotNull('purge_after').where('purge_after', '<=', nowIso),
    (event, photo) => purgePhoto(event, photo, { due: nowIso, now }),
  );
  await run(
    () => db('photos').whereNotNull('deleted_at').whereNull('purge_after').where('deleted_at', '<', staleIso),
    async (event, photo) => {
      const reclaimed = await db('photos')
        .where({ id: photo.id })
        .whereNull('purge_after')
        .where('deleted_at', '<', staleIso)
        .update({ deleted_at: nowIso });
      if (reclaimed !== 1) return false;
      await deletePhotoForGood(event, photo, { strict: true });
      return true;
    },
  );

  if (purged > 0) logger.info(`Photo trash: deleted ${purged} photo(s) for good`);
  return purged;
}

const task = scheduledTask(async () => {
  try {
    await purgeExpired();
  } catch (error) {
    logger.error('Photo trash sweep failed', { error: error.message });
  }
}, { schedule: '37 * * * *' });
function startPhotoTrashPurge() { task.start(); }
const stopPhotoTrashPurge = () => task.stop();

module.exports = {
  SETTING_KEY,
  DEFAULT_RETENTION_DAYS,
  MAX_RETENTION_DAYS,
  getRetentionDays,
  trashPhoto,
  listTrash,
  findTrashed,
  restorePhotos,
  deletePhotoForGood,
  purgePhoto,
  purgeEventTrash,
  purgeExpired,
  startPhotoTrashPurge,
  stopPhotoTrashPurge,
};
