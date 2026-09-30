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

module.exports = { heroAnchorPoint, normalizeHeroAnchor, heroAnchorQuery };
