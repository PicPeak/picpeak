'use strict';

// A photo's focal point (issue 2377): photos.focal_x / focal_y, fractions of
// the oriented image from its left and top edge, and focal_source ('auto' or
// 'manual').
//
// It is applied with CSS object-position semantics everywhere, server crop
// included: x of the slack goes left of the window, 1 - x right of it, as
// heroAnchor does for the hero. Two things follow. The point is always inside
// the window, whatever the window's shape. And it sits at the same fraction
// of the cropped thumbnail as of the source, so the gallery can apply the one
// stored value as object-position to any rendition, cover-cropped or not, and
// a tile of another shape crops around the same point again instead of
// shifting it.

const FOCAL_COLUMNS = ['focal_x', 'focal_y', 'focal_source'];
const FOCAL_SOURCES = ['auto', 'manual'];

const isFraction = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
const round = (value) => Math.round(value * 1000) / 1000;

/** `{ x, y }` from a photo row, or null for none (the centre crop). */
function focalPointOf(row) {
  if (!row || row.focal_x == null || row.focal_y == null) return null;
  const x = Number(row.focal_x);
  const y = Number(row.focal_y);
  return isFraction(x) && isFraction(y) ? { x, y } : null;
}

/** A focal point as stored: three decimals, which is finer than any thumbnail pixel. */
function normalizeFocalPoint(point) {
  if (!point || !isFraction(point.x) || !isFraction(point.y)) return null;
  return { x: round(point.x), y: round(point.y) };
}

/** The columns to write for a point and its source; null clears all three. */
function focalColumns(point, source) {
  const normalized = normalizeFocalPoint(point);
  return normalized
    ? { focal_x: normalized.x, focal_y: normalized.y, focal_source: source }
    : { focal_x: null, focal_y: null, focal_source: null };
}

/**
 * The columns a new row takes from generateThumbnail's `meta.focal`: the
 * detected point, or nothing (the columns default to NULL).
 */
function detectedFocalColumns(meta) {
  return meta && meta.focal ? focalColumns(meta.focal, 'auto') : {};
}

function sameFocalPoint(a, b) {
  const p = focalPointOf(a);
  const q = focalPointOf(b);
  return p === q || (Boolean(p && q) && p.x === q.x && p.y === q.y);
}

/** The same point from the same source (the three focal columns). */
function sameFocalColumns(a, b) {
  return sameFocalPoint(a, b) && (a?.focal_source || null) === (b?.focal_source || null);
}

/**
 * Query fragment for thumbnail URLs: empty without a point, so existing URLs
 * do not change. The thumbnail routes cache under the URL and a re-cropped
 * thumbnail lands under the same storage key, so a moved point has to be a
 * new URL (as the hero's `fp`, and a video's `poster`).
 */
function focalQuery(row) {
  const point = focalPointOf(row);
  return point ? `fp=${Math.round(point.x * 1000)}-${Math.round(point.y * 1000)}` : '';
}

/**
 * The window of an oriented `width` x `height` source that a cover crop to
 * `boxWidth` x `boxHeight` keeps, placed at `point`; null without a point.
 * sharp then scales the window to the box, so only its shape and place
 * matter here. A box larger than the source on either side is not enlarged
 * to (generateThumbnail passes withoutEnlargement): sharp keeps the source's
 * scale and cuts the box down to it on each side, so the window is that
 * piece, placed at the point like any other.
 */
function focalCoverWindow(width, height, boxWidth, boxHeight, point) {
  if (!point || !(width > 0) || !(height > 0) || !(boxWidth > 0) || !(boxHeight > 0)) return null;
  let windowWidth;
  let windowHeight;
  if (boxWidth > width || boxHeight > height) {
    windowWidth = Math.min(boxWidth, width);
    windowHeight = Math.min(boxHeight, height);
  } else {
    const boxRatio = boxWidth / boxHeight;
    windowWidth = Math.min(width, Math.max(1, Math.round(height * boxRatio)));
    windowHeight = Math.min(height, Math.max(1, Math.round(width / boxRatio)));
  }
  return {
    left: Math.round((width - windowWidth) * point.x),
    top: Math.round((height - windowHeight) * point.y),
    width: windowWidth,
    height: windowHeight,
  };
}

module.exports = {
  FOCAL_COLUMNS, FOCAL_SOURCES, focalPointOf, normalizeFocalPoint, focalColumns,
  detectedFocalColumns, sameFocalPoint, sameFocalColumns, focalQuery, focalCoverWindow,
};
