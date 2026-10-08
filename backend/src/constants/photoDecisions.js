/**
 * Approve / reject per photo (issue 744): the client's explicit verdict on a
 * single photo while proofing. One per guest per photo, changeable, exactly
 * like a colour label (constants/colorLabels.js).
 *
 * Mirrored in frontend/src/services/feedback.service.ts (PHOTO_DECISIONS) —
 * update both together.
 */

const PHOTO_DECISIONS = ['approved', 'rejected'];

/** Longest reason a guest can attach to a decision. */
const DECISION_REASON_MAX_LENGTH = 500;

function isValidDecision(value) {
  return PHOTO_DECISIONS.includes(value);
}

module.exports = {
  PHOTO_DECISIONS,
  DECISION_REASON_MAX_LENGTH,
  isValidDecision,
};
