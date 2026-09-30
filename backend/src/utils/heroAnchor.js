'use strict';

// The hero focal point (issue 1737). events.hero_image_anchor is a legacy
// keyword or "X% Y%" (validated on write by eventSettings.validateHeroImageAnchor).
// The gallery applies it as CSS object-position, which can only move within
// whatever the stored rendition kept — so the server-side crop has to follow
// it as well, and both sides need one reading of the value.
const KEYWORDS = { top: [50, 0], center: [50, 50], bottom: [50, 100] };

/** [x, y] in percent, 0-100; anything unreadable is the centre. */
function heroAnchorPoint(anchor) {
  if (typeof anchor === 'string' && Object.prototype.hasOwnProperty.call(KEYWORDS, anchor)) {
    return KEYWORDS[anchor];
  }
  const match = typeof anchor === 'string' && anchor.match(/^(\d{1,3})%\s+(\d{1,3})%$/);
  if (!match) return KEYWORDS.center;
  const clamp = (n) => Math.min(100, Math.max(0, parseInt(n, 10)));
  return [clamp(match[1]), clamp(match[2])];
}

/** Canonical "X% Y%" form — the value stored in photos.hero_anchor. */
function normalizeHeroAnchor(anchor) {
  const [x, y] = heroAnchorPoint(anchor);
  return `${x}% ${y}%`;
}

/** Query fragment for hero URLs: empty at the centre, so existing URLs do not change. */
function heroAnchorQuery(anchor) {
  const [x, y] = heroAnchorPoint(anchor);
  return x === 50 && y === 50 ? '' : `fp=${x}-${y}`;
}

/**
 * Where a hero request whose `fp` does not match the event's anchor has to
 * go: the query string for the current crop (other parameters kept), or
 * null when the URL already matches.
 *
 * The hero route caches for an hour under the URL it was requested at. An
 * open tab holding a payload from before the admin moved the focal point
 * still asks for the old URL; serving it the current crop would park an
 * off-centre rendition under the centre URL for that hour, and it would
 * resurface after the admin moved the point back.
 */
function heroQueryRedirect(query, anchor) {
  const wanted = heroAnchorQuery(anchor);
  const given = typeof query.fp === 'string' ? `fp=${query.fp}` : '';
  if (given === wanted) return null;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query || {})) {
    if (key !== 'fp' && typeof value === 'string') params.set(key, value);
  }
  if (wanted) params.set('fp', wanted.slice('fp='.length));
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

/**
 * Storage name of the hero rendition for a source basename at an anchor.
 *
 * One file per anchor, not one file per photo: the watermark cache keys on
 * the file path for an hour, and two requests for different anchors must
 * never share an in-flight generation or overwrite each other's output. The
 * centre keeps the pre-258 name, so existing renditions stay valid.
 */
function heroRenditionName(basename, anchor) {
  const [x, y] = heroAnchorPoint(anchor);
  return x === 50 && y === 50 ? `hero_${basename}` : `hero_fp${x}-${y}_${basename}`;
}

module.exports = { heroAnchorPoint, normalizeHeroAnchor, heroAnchorQuery, heroQueryRedirect, heroRenditionName };
