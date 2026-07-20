/**
 * Emoji reactions on photos (#839).
 *
 * - event_feedback_settings.allow_reactions: per-event toggle next to
 *   allow_likes / allow_ratings / allow_comments. Defaults TRUE for parity
 *   with the sibling toggles — the master feedback_enabled gate (default
 *   false, opt-in per event) still decides whether any feedback UI shows.
 * - photo_feedback.reaction: the emoji value for feedback_type='reaction'
 *   rows (validated against the fixed set in constants/reactions.js).
 * - photos.reaction_count: denormalized total, maintained by
 *   updatePhotoFeedbackStats alongside like_count / favorite_count.
 */

exports.up = async function (knex) {
  const hasAllowReactions = await knex.schema.hasColumn('event_feedback_settings', 'allow_reactions');
  if (!hasAllowReactions) {
    await knex.schema.alterTable('event_feedback_settings', (table) => {
      table.boolean('allow_reactions').defaultTo(true);
    });
  }

  const hasReaction = await knex.schema.hasColumn('photo_feedback', 'reaction');
  if (!hasReaction) {
    await knex.schema.alterTable('photo_feedback', (table) => {
      // 16 chars: emoji are multi-byte/multi-codepoint (variation selectors),
      // but well under 16 characters each.
      table.string('reaction', 16);
    });
  }

  const hasReactionCount = await knex.schema.hasColumn('photos', 'reaction_count');
  if (!hasReactionCount) {
    await knex.schema.alterTable('photos', (table) => {
      table.integer('reaction_count').defaultTo(0);
    });
  }
};

exports.down = async function (knex) {
  if (await knex.schema.hasColumn('photos', 'reaction_count')) {
    await knex.schema.alterTable('photos', (table) => {
      table.dropColumn('reaction_count');
    });
  }
  if (await knex.schema.hasColumn('photo_feedback', 'reaction')) {
    await knex.schema.alterTable('photo_feedback', (table) => {
      table.dropColumn('reaction');
    });
  }
  if (await knex.schema.hasColumn('event_feedback_settings', 'allow_reactions')) {
    await knex.schema.alterTable('event_feedback_settings', (table) => {
      table.dropColumn('allow_reactions');
    });
  }
};
