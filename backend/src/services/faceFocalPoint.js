'use strict';

/**
 * A photo's focal point from the faces the face scan found (issue 2377).
 *
 * sharp's attention pass guesses from skin tones, saturation and edges, and a
 * busy background or a group can pull it off the people. Where the scan
 * found faces, the crop keeps them: the point is the middle of the box around
 * every face at least a quarter the size of the largest one, so a guest far
 * behind the couple does not move it. Face boxes are in the oriented
 * original's pixels (faceProcessor scales them), as photos.width/height are.
 *
 * A scan that finds faces cuts the thumbnail again around them, unless an
 * admin set the point by hand (refocusFromFaces). The thumbnail rebuild uses
 * faces before sharp whenever it detects a point (imageProcessor).
 */

const { db } = require('../database/db');
const logger = require('../utils/logger');
const { normalizeFocalPoint, sameFocalPoint } = require('../utils/focalPoint');

// A face smaller than this share of the largest one does not pull the point.
const MIN_AREA_SHARE = 0.25;

/** `{ x, y }` fractions from a photo's faces, or null without any. Never throws. */
async function faceFocalPoint(photoId) {
  try {
    const photo = await db('photos').where({ id: photoId }).first('width', 'height');
    const width = Number(photo?.width);
    const height = Number(photo?.height);
    if (!(width > 0) || !(height > 0)) return null;
    const faces = (await db('photo_faces').where({ photo_id: photoId })
      .select('bbox_x', 'bbox_y', 'bbox_w', 'bbox_h'))
      .map((face) => ({ x: Number(face.bbox_x), y: Number(face.bbox_y), w: Number(face.bbox_w), h: Number(face.bbox_h) }))
      .filter((face) => [face.x, face.y].every(Number.isFinite) && face.w > 0 && face.h > 0);
    if (!faces.length) return null;
    const largest = Math.max(...faces.map((face) => face.w * face.h));
    const kept = faces.filter((face) => face.w * face.h >= largest * MIN_AREA_SHARE);
    const left = Math.min(...kept.map((face) => face.x));
    const top = Math.min(...kept.map((face) => face.y));
    const right = Math.max(...kept.map((face) => face.x + face.w));
    const bottom = Math.max(...kept.map((face) => face.y + face.h));
    const clamp = (value) => Math.min(1, Math.max(0, value));
    return normalizeFocalPoint({ x: clamp((left + right) / 2 / width), y: clamp((top + bottom) / 2 / height) });
  } catch (error) {
    logger.warn(`Could not read the faces of photo ${photoId} for its focal point: ${error.message}`);
    return null;
  }
}

/**
 * After a face scan: cut the thumbnail again around the faces when they put
 * the point elsewhere than the row has it. A point set by hand stays; the
 * rebuild checks that again on the row it reads. Never throws: the faces are
 * stored either way.
 */
async function refocusFromFaces(photo) {
  if (!photo || photo.focal_source === 'manual') return false;
  const point = await faceFocalPoint(photo.id);
  if (!point || sameFocalPoint(photo, { focal_x: point.x, focal_y: point.y })) return false;
  try {
    const { ensureThumbnail } = require('./imageProcessor');
    return Boolean(await ensureThumbnail(photo, { force: true, focalPoint: { redetect: true } }));
  } catch (error) {
    logger.warn(`Could not cut photo ${photo.id}'s thumbnail around its faces: ${error.message}`);
    return false;
  }
}

module.exports = { MIN_AREA_SHARE, faceFocalPoint, refocusFromFaces };
