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

/** Face boxes of the upright original, in the pixels of its edit; those the crop left out are dropped. */
function facesInEdit(edit, width, height, faces) {
  const math = require('../utils/photoEditMath');
  const size = math.outputSize(edit, width, height);
  const moved = [];
  for (const face of faces) {
    const corners = [[face.x, face.y], [face.x + face.w, face.y], [face.x, face.y + face.h], [face.x + face.w, face.y + face.h]]
      .map(([x, y]) => math.mapPointToEdited(edit, width, height, { x: x / width, y: y / height }));
    const left = clamp(Math.min(...corners.map((p) => p.x)));
    const right = clamp(Math.max(...corners.map((p) => p.x)));
    const top = clamp(Math.min(...corners.map((p) => p.y)));
    const bottom = clamp(Math.max(...corners.map((p) => p.y)));
    if (right <= left || bottom <= top) continue;
    moved.push({ x: left * size.width, y: top * size.height, w: (right - left) * size.width, h: (bottom - top) * size.height });
  }
  return { faces: moved, width: size.width, height: size.height };
}

/** `{ x, y }` fractions from a photo's faces, or null without any. Never throws. */
async function faceFocalPoint(photoId) {
  try {
    const photo = await db('photos').where({ id: photoId }).first('width', 'height', 'edit_params', 'media_type', 'mime_type');
    let width = Number(photo?.width);
    let height = Number(photo?.height);
    if (!(width > 0) || !(height > 0)) return null;
    let faces = (await db('photo_faces').where({ photo_id: photoId })
      .select('bbox_x', 'bbox_y', 'bbox_w', 'bbox_h'))
      .map((face) => ({ x: Number(face.bbox_x), y: Number(face.bbox_y), w: Number(face.bbox_w), h: Number(face.bbox_h) }))
      .filter((face) => [face.x, face.y].every(Number.isFinite) && face.w > 0 && face.h > 0);
    if (!faces.length) return null;
    // faceProcessor scales the boxes by photos.width over the preview's
    // width. A row whose dimensions were stored unrotated (before #1185, until
    // the orientation repair fixes them and scans its faces again) has boxes
    // that do not fit it; sharp's guess stands in for those.
    if (faces.some((face) => face.x + face.w > width + 1 || face.y + face.h > height + 1)) return null;
    // An edited photo's thumbnail is cut from the edit (issue 2619): the
    // boxes move with its crop, turn and flip, and a face cropped away
    // does not count.
    const edit = require('./photoEdits').paramsOf(photo);
    if (edit) {
      ({ faces, width, height } = facesInEdit(edit, width, height, faces));
      if (!faces.length) return null;
    }
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

/**
 * A face box as the photo's guests see it (issue 2619): `row` carries the
 * box in original pixels (bbox_x..bbox_h), photo_width / photo_height and
 * the photo's applied edit (edit_applied_params, edit_applied_width /
 * edit_applied_height, edit_applied_rev). The box and the size it is
 * measured against are those of the applied revision's delivered image,
 * the one its previews show (smaller than the edit when the render is
 * capped or a RAW was developed at half size): a newer save still being
 * applied, or one whose render failed, changes nothing until it lands.
 * Null when the edit cropped the face away. Unedited photos are returned
 * as they are.
 */
function faceBoxForGuests(row) {
  // The applied revision names the preview the box is to be cut from (the
  // admin preview URL's `e=`), so no older cached preview meets new boxes.
  const version = { edit_applied_rev: Number(row.edit_applied_rev) || 0 };
  const box = { bbox: [row.bbox_x, row.bbox_y, row.bbox_w, row.bbox_h], photo_width: row.photo_width ?? null, photo_height: row.photo_height ?? null, ...version };
  const edit = require('./photoEdits').paramsOf({ edit_params: row.edit_applied_params });
  const width = Number(row.photo_width);
  const height = Number(row.photo_height);
  if (!edit || !(width > 0) || !(height > 0)) return box;
  const moved = facesInEdit(edit, width, height, [{ x: Number(row.bbox_x), y: Number(row.bbox_y), w: Number(row.bbox_w), h: Number(row.bbox_h) }]);
  if (!moved.faces.length) return null;
  const round = (v) => Math.round(v * 100) / 100;
  const [face] = moved.faces;
  const delivered = {
    width: Number(row.edit_applied_width) || moved.width,
    height: Number(row.edit_applied_height) || moved.height,
  };
  const sx = delivered.width / moved.width;
  const sy = delivered.height / moved.height;
  return {
    bbox: [round(face.x * sx), round(face.y * sy), round(face.w * sx), round(face.h * sy)],
    photo_width: delivered.width, photo_height: delivered.height, ...version,
  };
}

module.exports = { faceFocalPoint, refocusFromFaces, faceBoxForGuests };
