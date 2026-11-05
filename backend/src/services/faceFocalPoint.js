'use strict';

/**
 * A photo's focal point from the faces the face scan found (issue 2377).
 *
 * sharp's attention pass guesses from skin tones, saturation and edges, and a
 * busy background or a group can pull it off the people. Where the scan
 * found faces, the crop keeps them: the box around every face at least a
 * quarter the size of the largest one (a guest far behind the couple does
 * not count) is centred in the thumbnail's crop, in its configured shape, as
 * far as the crop's slack allows. Face boxes are in the oriented
 * original's pixels (faceProcessor scales them), as photos.width/height are.
 *
 * A scan that finds faces cuts the thumbnail again around them, unless an
 * admin set the point by hand (refocusFromFaces). The thumbnail rebuild uses
 * faces before sharp whenever it detects a point (imageProcessor).
 */

const { db } = require('../database/db');
const logger = require('../utils/logger');
const { focalCoverWindow, normalizeFocalPoint } = require('../utils/focalPoint');

// A face smaller than this share of the largest one does not pull the point.
const MIN_AREA_SHARE = 0.25;

const clamp = (value) => Math.min(1, Math.max(0, value));

/**
 * The point along one side of `length` for faces spanning `from`..`to`.
 * The point places a crop the way object-position does (utils/focalPoint):
 * a fraction of the slack, not the window's middle. So the faces' middle is
 * not passed as it is: for an off-centre group that window would cut off
 * the outer face. The point is the one that centres the faces in the
 * thumbnail's window (`side` long on this axis, from the configured
 * thumbnail shape), moved as little as needed to keep every face in it
 * where they fit. Without slack (the window spans this side) the faces'
 * middle stands for the other window shapes.
 */
function placeOn(length, side, from, to) {
  const slack = length - side;
  if (slack <= 0) return clamp((from + to) / 2 / length);
  const centred = ((from + to) / 2 - side / 2) / slack;
  const lowest = (to - side) / slack;
  const highest = from / slack;
  return clamp(lowest <= highest ? Math.min(highest, Math.max(lowest, centred)) : centred);
}

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
    // faceProcessor scales the boxes by photos.width over the preview's
    // width. A row whose dimensions were stored unrotated (before #1185, until
    // the orientation repair fixes them and scans its faces again) has boxes
    // that do not fit it; sharp's guess stands in for those.
    if (faces.some((face) => face.x + face.w > width + 1 || face.y + face.h > height + 1)) return null;
    const largest = Math.max(...faces.map((face) => face.w * face.h));
    const kept = faces.filter((face) => face.w * face.h >= largest * MIN_AREA_SHARE);
    const left = Math.min(...kept.map((face) => face.x));
    const top = Math.min(...kept.map((face) => face.y));
    const right = Math.max(...kept.map((face) => face.x + face.w));
    const bottom = Math.max(...kept.map((face) => face.y + face.h));
    // The window the thumbnail's cover crop keeps, in the configured shape.
    const { getThumbnailSettings } = require('./imageProcessor');
    const settings = await getThumbnailSettings();
    const crop = focalCoverWindow(width, height, settings.width, settings.height, { x: 0, y: 0 });
    return normalizeFocalPoint({
      x: placeOn(width, crop.width, left, right),
      y: placeOn(height, crop.height, top, bottom),
    });
  } catch (error) {
    logger.warn(`Could not read the faces of photo ${photoId} for its focal point: ${error.message}`);
    return null;
  }
}

/**
 * After a face scan: cut the thumbnail again around the faces, unless the
 * row's point is already on them or was set by hand. Never throws: the
 * faces are stored either way.
 */
async function refocusFromFaces(photo) {
  if (!photo) return false;
  // Whether the point is manual, or already sits on the faces, is decided in
  // the rebuild's flight on the row read there: the caller's row predates the
  // scan, and an admin may have gone back to automatic meanwhile.
  if (!(await faceFocalPoint(photo.id))) return false;
  try {
    const { ensureThumbnail } = require('./imageProcessor');
    return Boolean(await ensureThumbnail(photo, { force: true, focalPoint: { redetect: true } }));
  } catch (error) {
    logger.warn(`Could not cut photo ${photo.id}'s thumbnail around its faces: ${error.message}`);
    return false;
  }
}

module.exports = { MIN_AREA_SHARE, faceFocalPoint, refocusFromFaces };
