/**
 * Find a guest's photos from one selfie (issue 2355).
 *
 * The selfie lives in memory for the length of the request and nowhere else:
 * it is normalised with sharp, sent to the ML sidecar for its face signature,
 * compared against the signatures already stored for this event's photos,
 * and dropped. No row, file, log line or person is written for it.
 *
 * Matching is against single faces, not person clusters: a guest the
 * clustering never grouped (too few photos, a bad cluster) is still found.
 * Embeddings are L2-normalised, so cosine similarity is a dot product.
 *
 * Only photos this viewer can already see are candidates: the gallery list
 * query (visibility, review, processing) bounds the set, and faces of a
 * person the photographer hid from guests are left out.
 */

const sharp = require('sharp');
const { db } = require('../database/db');
const { detectFaces } = require('./faceClient');
const { getThresholds } = require('./faceSettings');
const { unpackEmbedding, normalize, dot } = require('./faceClustering');

// A selfie needs no more than this for a face signature; it also bounds the
// sidecar's work for a 50-megapixel phone photo.
const MAX_EDGE_PX = 1280;
const MAX_INPUT_PIXELS = 60_000_000;

class SelfieImageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SelfieImageError';
  }
}

async function normaliseSelfie(buffer) {
  try {
    return await sharp(buffer, { limitInputPixels: MAX_INPUT_PIXELS })
      .rotate()
      .resize({ width: MAX_EDGE_PX, height: MAX_EDGE_PX, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 90 })
      .toBuffer();
  } catch {
    throw new SelfieImageError('The file is not an image that can be read');
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
    .where((q) => q.whereNull('photo_faces.person_id').orWhere('event_people.is_hidden', false))
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

module.exports = { findPhotosBySelfie, SelfieImageError, largestFace };
