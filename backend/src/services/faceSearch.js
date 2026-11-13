/**
 * Find a guest's photos from one selfie (issue 2355).
 *
 * The selfie is kept for the length of the request and nowhere else: it is
 * normalised, sent to the ML sidecar for its face signature, compared against
 * the signatures already stored for this event's photos, and dropped. No row,
 * log line or person is written for it. Decoding runs in the isolated image
 * worker like every other image a visitor sends, so its limits, queue and
 * deadline apply; the worker (and the HEIC decoder) read their input from a
 * private temporary file that is removed as soon as the step ends.
 *
 * Matching is against single faces, not person clusters: a guest the
 * clustering never grouped (too few photos, a bad cluster) is still found.
 * Embeddings are L2-normalised, so cosine similarity is a dot product.
 *
 * Only photos this viewer can already see are candidates: the gallery list
 * query (visibility, review, processing) bounds the set, and faces of a
 * person the photographer hid from guests or dismissed are left out.
 */

const sharp = require('./isolatedSharp');
const { db } = require('../database/db');
const { detectFaces } = require('./faceClient');
const { getThresholds } = require('./faceSettings');
const { unpackEmbedding, normalize, dot } = require('./faceClustering');
const { isResourceError } = require('./imageResourcePolicy');

// A selfie needs no more than this for a face signature; it also bounds the
// sidecar's work for a 50-megapixel phone photo.
const MAX_EDGE_PX = 1280;
// The sidecar's multipart parser (Starlette) keeps an upload in memory up to
// 1 MiB and spools anything larger to a temporary file. The JPEG sent there
// stays below that: a busy 1280 px photo can pass 1 MiB at quality 90, so the
// quality and then the size step down until it fits.
const MAX_SIDECAR_BYTES = 900 * 1024;
const ENCODINGS = [
  { edge: MAX_EDGE_PX, quality: 85 },
  { edge: MAX_EDGE_PX, quality: 70 },
  { edge: 1024, quality: 70 },
  { edge: 800, quality: 60 },
];

class SelfieImageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SelfieImageError';
  }
}

// The image worker's own refusals (too many pixels, busy, timed out) pass
// through for the route to answer; anything else means the file is no image.
const asSelfieError = (error) => (isResourceError(error)
  ? error
  : new SelfieImageError('The file is not an image that can be read'));

async function normaliseSelfie(buffer, maxBytes = MAX_SIDECAR_BYTES) {
  // An iPhone HEIC is HEVC-coded, which sharp cannot decode: it goes through
  // the same decoder as an uploaded HEIC photo.
  let standIn = null;
  try {
    standIn = await require('./imageProcessor').heifStandIn(buffer);
  } catch (error) {
    throw asSelfieError(error);
  }
  try {
    const input = standIn ? standIn.path : buffer;
    for (const { edge, quality } of ENCODINGS) {
      let jpeg;
      try {
        jpeg = await sharp(input, { interactive: true })
          .rotate()
          .resize({ width: edge, height: edge, fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality })
          .toBuffer();
      } catch (error) {
        throw asSelfieError(error);
      }
      if (jpeg.length <= maxBytes) return jpeg;
    }
    throw new SelfieImageError('The image is too detailed to search with');
  } finally {
    if (standIn) await standIn.cleanup();
  }
}

// The face the selfie is of: the largest one, so a friend in the background
// does not decide the search.
function largestFace(faces) {
  let best = null;
  let bestArea = -1;
  for (const face of faces) {
    if (!Array.isArray(face?.embedding) || face.embedding.length === 0) continue;
    const [, , w = 0, h = 0] = face.bbox || [];
    const area = w * h;
    if (area > bestArea) {
      best = face;
      bestArea = area;
    }
  }
  return best;
}

/**
 * Returns { faceFound: false } or { faceFound: true, photoIds } with the
 * matching photo ids, best match first.
 */
async function findPhotosBySelfie({ event, accessLevel, imageBuffer }) {
  const jpeg = await normaliseSelfie(imageBuffer);
  const result = await detectFaces(jpeg, 'selfie.jpg');
  const face = largestFace(result?.faces || []);
  if (!face) return { faceFound: false };

  const probe = normalize(Float32Array.from(face.embedding));
  const modelVersion = result?.model_version || null;
  const { face_selfie_match_threshold: threshold } = await getThresholds();

  const { galleryListQuery } = require('./galleryQueryService');
  const { photosQuery } = await galleryListQuery({ event, query: {}, identity: {}, accessLevel });
  const visiblePhotoIds = photosQuery.clearSelect().select('photos.id');

  const rows = await db('photo_faces')
    .leftJoin('event_people', 'event_people.id', 'photo_faces.person_id')
    .where('photo_faces.event_id', event.id)
    .whereIn('photo_faces.photo_id', visiblePhotoIds)
    .whereNotNull('photo_faces.embedding')
    // Faces of a person the photographer hid from guests or dismissed
    // (ignored: a bystander, a false detection) are not candidates, as in
    // the people strip (facePeopleService).
    .where((q) => q.whereNull('photo_faces.person_id')
      .orWhere((p) => p.where('event_people.is_hidden', false).where('event_people.is_ignored', false)))
    // A signature from another model version is not comparable.
    .modify((q) => {
      if (modelVersion) {
        q.where((w) => w.where('photo_faces.model_version', modelVersion).orWhereNull('photo_faces.model_version'));
      }
    })
    .select('photo_faces.photo_id', 'photo_faces.embedding');

  const bestByPhoto = new Map();
  for (const row of rows) {
    const vec = unpackEmbedding(row.embedding);
    if (!vec || vec.length !== probe.length) continue;
    const score = dot(probe, vec);
    if (score < threshold) continue;
    const photoId = Number(row.photo_id);
    if (score > (bestByPhoto.get(photoId) ?? -Infinity)) bestByPhoto.set(photoId, score);
  }

  const photoIds = [...bestByPhoto.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([photoId]) => photoId);
  return { faceFound: true, photoIds };
}

module.exports = { findPhotosBySelfie, SelfieImageError, largestFace, normaliseSelfie, MAX_SIDECAR_BYTES };
