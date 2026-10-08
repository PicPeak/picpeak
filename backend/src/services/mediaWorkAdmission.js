const crypto = require('crypto');
const { db } = require('../database/db');
const { configuration: imageConfiguration, isResourceError } = require('./imageResourcePolicy');
const { configuration, estimate, refusal } = require('./mediaProcessPolicy');
const processes = require('./mediaProcessService');

async function inspect(localPath, signal) {
  try { return estimate(await processes.probeVideo(localPath, { signal })); }
  catch (error) {
    if (isResourceError(error)) throw error;
    // A signature-valid broken/quirky video keeps the existing placeholder
    // workflow, charged conservatively rather than trusted as zero work.
    const policy = configuration(); return { decodedBytes: policy.decodedBytes, work: policy.maxWork };
  }
}
async function reserve(eventId, estimate, batch) {
  const image = imageConfiguration(), media = configuration();
  const { decodedBytes, work } = estimate;
  if (!Number.isSafeInteger(decodedBytes) || decodedBytes <= 0 || decodedBytes > image.decodedBytes ||
      !Number.isSafeInteger(work) || work <= 0 || work > media.maxWork || batch.bytes > image.batchBytes || batch.work > media.maxWork * 2) throw refusal('Media batch exceeds its decoded processing budget');
  const id = crypto.randomUUID();
  await db.transaction(async trx => {
    if (await trx('image_work_lock').where({ id: 1 }).update({ revision: 0 }) !== 1) throw refusal('Media admission is unavailable', 'MEDIA_ADMISSION_UNAVAILABLE');
    const sum = async (table, field, where) => {
      let query = trx(table); if (where) query = query.where(where);
      const value = Number((await query.sum(`${field} as total`).first())?.total || 0);
      if (!Number.isSafeInteger(value) || value < 0) throw refusal('Media admission is unavailable', 'MEDIA_ADMISSION_UNAVAILABLE');
      return value;
    };
    if ((await sum('image_work_reservations', 'decoded_bytes', { event_id: eventId })) + decodedBytes > image.eventBytes ||
        (await sum('image_work_reservations', 'decoded_bytes')) + decodedBytes > image.deploymentBytes ||
        (await sum('media_video_work_reservations', 'work_units', { event_id: eventId })) + work > media.maxWork * 4 ||
        (await sum('media_video_work_reservations', 'work_units')) + work > media.maxWork * 8) throw refusal('Queued media exceeds its decoded processing budget');
    await trx('image_work_reservations').insert({ id, event_id: eventId, decoded_bytes: decodedBytes });
    await trx('media_video_work_reservations').insert({ id, event_id: eventId, work_units: work });
  });
  return id;
}
async function attach(id, photoId, conn = db) {
  const row = await conn('media_video_work_reservations').where({ id }).first();
  if (row && await conn('media_video_work_reservations').where({ id }).whereNull('photo_id').update({ photo_id: photoId }) !== 1) throw refusal('Video reservation could not be committed', 'MEDIA_ADMISSION_UNAVAILABLE');
}
async function release(id) { if (id) await db('media_video_work_reservations').where({ id }).delete(); }
async function finish(photoId) { await db('media_video_work_reservations').where({ photo_id: photoId }).delete(); }
async function ensureQueued(photo) {
  const existing = await db('media_video_work_reservations').where({ photo_id: photo.id }).first();
  if (existing) return;
  const { withLocalCopy } = require('./imageProcessor');
  const { resolvePhotoStorageKey, resolvePhotoFilePath } = require('./photoResolver');
  const event = await db('events').where({ id: photo.event_id }).first();
  if (!event) throw refusal('Media event is unavailable', 'MEDIA_ADMISSION_UNAVAILABLE');
  const key = resolvePhotoStorageKey(event, photo);
  const value = key ? await withLocalCopy(key, inspect) : await inspect(resolvePhotoFilePath(event, photo));
  const id = await reserve(photo.event_id, value, { bytes: value.decodedBytes, work: value.work });
  try {
    await db.transaction(async trx => {
      if (!(await trx('photos').where({ id: photo.id, path: photo.path, filename: photo.filename }).first())) throw refusal('Media source was superseded', 'MEDIA_SUPERSEDED');
      await require('./imageWorkAdmission').attach(id, photo.id, trx);
      await attach(id, photo.id, trx);
    });
  } catch (error) {
    await Promise.all([release(id), require('./imageWorkAdmission').release(id)]); throw error;
  }
}
module.exports = { inspect, reserve, attach, release, finish, ensureQueued };
