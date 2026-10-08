const crypto = require('crypto');
const fs = require('fs').promises;
const { db } = require('../database/db');
const sharp = require('./isolatedSharp');
const { configuration, estimate, refusal } = require('./imageResourcePolicy');

async function inspect(localPath, originalName, signal, prepared) {
  const cached = prepared?.get(localPath);
  if (cached) {
    if (cached.error) throw Object.assign(new Error(cached.error.message), { code: cached.error.code, status: 422 });
    const stat = await fs.stat(localPath);
    if (Object.entries(cached.fingerprint).every(([key, value]) => stat[key] === value)) return cached.decodedBytes;
    // A changed file never inherits a stale decoded charge.
  }
  // RAW extraction remains the existing finite exiftool workflow. Its JPEG
  // preview enters exactly the same isolated parser and decoded policy.
  const { withProcessableImage } = require('./imageProcessor');
  const processable = await withProcessableImage(localPath, originalName);
  try { return estimate(await sharp(processable.path, { signal }).metadata()); }
  finally { await processable.cleanup(); }
}
async function prepareBatch(files, signal) {
  if (files.length < 8) return null;
  const { isRawFilename } = require('../utils/rawFormats');
  const entries = files.filter(file => !file.mimetype?.startsWith('video/') && !isRawFilename(file.originalname))
    .map(file => file.path || file.filepath || file.tempFilePath).filter(Boolean);
  if (!entries.length) return null;
  try { return new Map((await sharp.metadataBatch(entries, { signal })).map(result => [result.input, result])); }
  catch (error) { return new Map(entries.map(input => [input, { error: { message: error.message, code: error.code || 'IMAGE_WORKER_FAILED' } }])); }
}
async function reserve(eventId, bytes, batchBytes) {
  const policy = configuration();
  if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > policy.decodedBytes || batchBytes > policy.batchBytes) {
    throw refusal('Image batch exceeds the decoded processing budget');
  }
  const id = crypto.randomUUID();
  await db.transaction(async trx => {
    if (await trx('image_work_lock').where({ id: 1 }).update({ revision: 0 }) !== 1) {
      throw refusal('Image admission is unavailable', 'IMAGE_ADMISSION_UNAVAILABLE');
    }
    const sum = async query => {
      const row = await query.sum('decoded_bytes as bytes').first();
      const value = Number(row?.bytes || 0);
      if (!Number.isSafeInteger(value) || value < 0) throw refusal('Image admission is unavailable', 'IMAGE_ADMISSION_UNAVAILABLE');
      return value;
    };
    if ((await sum(trx('image_work_reservations').where({ event_id: eventId }))) + bytes > policy.eventBytes ||
        (await sum(trx('image_work_reservations'))) + bytes > policy.deploymentBytes) {
      throw refusal('Queued images exceed the decoded processing budget');
    }
    await trx('image_work_reservations').insert({ id, event_id: eventId, decoded_bytes: bytes });
  });
  return id;
}
async function attach(id, photoId, conn = db) {
  if (await conn('image_work_reservations').where({ id }).whereNull('photo_id').update({ photo_id: photoId }) !== 1) {
    throw refusal('Image reservation could not be committed', 'IMAGE_ADMISSION_UNAVAILABLE');
  }
}
async function release(id) { if (id) await db('image_work_reservations').where({ id }).delete(); }
async function finish(photoId) { await db('image_work_reservations').where({ photo_id: photoId }).delete(); }
module.exports = { inspect, prepareBatch, reserve, attach, release, finish };
