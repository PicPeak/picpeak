/**
 * Emoji reactions (#839): the fixed, curated reaction set. Guests pick ONE
 * of these per photo (changeable). Kept as a shared constant so the
 * validator, the service and the export layer can never drift apart.
 *
 * Mirrored in frontend/src/services/feedback.service.ts (REACTION_EMOJIS) —
 * update both together.
 */
const REACTION_EMOJIS = ['❤️', '😂', '😍', '👏', '🎉'];

module.exports = { REACTION_EMOJIS };
