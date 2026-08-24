/**
 * Merging several proofing verdicts into the single value a desktop
 * cataloguer can apply (Lightroom round-trip, #745).
 *
 * A photo can carry three different opinions at once: the guest colour
 * tallies in `photo_feedback`, the guest star average denormalized onto
 * `photos.average_rating`, and the photographer's own triage in
 * `photo_admin_marks`. Lightroom has room for exactly one colour label and
 * one star rating per photo, so something has to decide.
 *
 * This is that decision, in one place, so the API response, the XMP export
 * and the plugin can never drift apart on it.
 */

const { COLOR_LABEL_PRIORITY } = require('../constants/colorLabels');

/**
 * Collapse a guest star average to Lightroom's 0-5 integer scale.
 *
 * Deliberately identical to XmpGenerator.mapRating so a photo exported as an
 * XMP sidecar and the same photo fetched through the v1 API never disagree
 * about how many stars it has. Note the last branch: any non-zero average
 * below 1.5 becomes 1 star, not 0 — "somebody rated this" and "nobody rated
 * this" must stay distinguishable.
 */
function roundRating(avgRating) {
  const value = parseFloat(avgRating);
  if (!value || Number.isNaN(value)) return 0;
  if (value >= 4.5) return 5;
  if (value >= 3.5) return 4;
  if (value >= 2.5) return 3;
  if (value >= 1.5) return 2;
  return 1;
}

/**
 * Pick the higher-priority of two colours.
 *
 * COLOR_LABEL_PRIORITY is green-first because in the proofing workflow this
 * exists for, green means "1st choice" — the pick that must survive a
 * disagreement.
 */
function higherPriorityColor(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  const ia = COLOR_LABEL_PRIORITY.indexOf(a);
  const ib = COLOR_LABEL_PRIORITY.indexOf(b);
  if (ia === -1) return b;
  if (ib === -1) return a;
  return ia <= ib ? a : b;
}

/**
 * Resolve one photo's marks down to a single colour and rating.
 *
 * @param {Object} photo - row enriched by photoExportService.getPhotosWithFeedback
 * @param {'client'|'mine'|'either'} markSource
 * @returns {{ color_label: string|null, rating: number|null }}
 */
function mergeMarks(photo, markSource = 'either') {
  if (!photo) return { color_label: null, rating: null };

  const clientColor = photo.dominant_color_label || null;
  const clientRating = roundRating(photo.average_rating);
  const myColor = photo.my_color_label || null;
  const myRating = Number(photo.my_rating) || 0;

  if (markSource === 'client') {
    return {
      color_label: clientColor,
      rating: clientRating || null,
    };
  }

  if (markSource === 'mine') {
    return {
      color_label: myColor,
      rating: myRating || null,
    };
  }

  // 'either' — the photographer's own mark wins the colour. It is one
  // person's deliberate triage rather than an aggregate that a tie-break
  // already had to guess at, so it is the stronger signal. Stars take the
  // max instead: a rating is a magnitude, and losing the higher of the two
  // would quietly demote a photo somebody rated highly.
  return {
    color_label: myColor || clientColor,
    rating: Math.max(myRating, clientRating) || null,
  };
}

module.exports = {
  mergeMarks,
  roundRating,
  higherPriorityColor,
};
