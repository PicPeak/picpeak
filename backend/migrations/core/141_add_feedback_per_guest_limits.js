/**
 * Migration 141: Per-guest favorite + like caps (#655).
 *
 * Reporter wants to cap how many photos a guest can favorite per event —
 * the classic photographer-culling workflow ("pick your top 10 for the
 * album"). Currently the photographer has to enforce this with a verbal
 * instruction; this column lets the gallery enforce it server-side so
 * the 11th favorite click returns a clear "limit reached" response.
 *
 * Two columns, one per feedback type: favorites + likes. Both nullable +
 * additive — null/0 = unlimited, preserving current behaviour for every
 * existing install with no operator action. The route layer enforces in
 * `feedbackService.submitFeedback` (on the INSERT branch only, so a
 * guest at the cap can still toggle off an existing favorite and free a
 * slot). Limit *reduction* (e.g. admin lowers 20 → 10) grandfathers any
 * over-cap rows already in place — new adds blocked, removals always
 * allowed — to avoid surprising bulk-deletes on the admin save.
 *
 * Hooks into the existing per-event `event_feedback_settings` table
 * alongside `allow_favorites` / `allow_likes`, so the admin surface is
 * the same Event → Feedback settings card.
 */
exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('event_feedback_settings'))) return;
  const hasFav = await knex.schema.hasColumn('event_feedback_settings', 'max_favorites_per_guest');
  const hasLike = await knex.schema.hasColumn('event_feedback_settings', 'max_likes_per_guest');
  if (hasFav && hasLike) return;
  await knex.schema.alterTable('event_feedback_settings', (table) => {
    if (!hasFav) table.integer('max_favorites_per_guest').nullable();
    if (!hasLike) table.integer('max_likes_per_guest').nullable();
  });
};

exports.down = async function (knex) {
  if (!(await knex.schema.hasTable('event_feedback_settings'))) return;
  const hasFav = await knex.schema.hasColumn('event_feedback_settings', 'max_favorites_per_guest');
  const hasLike = await knex.schema.hasColumn('event_feedback_settings', 'max_likes_per_guest');
  if (!hasFav && !hasLike) return;
  await knex.schema.alterTable('event_feedback_settings', (table) => {
    if (hasFav) table.dropColumn('max_favorites_per_guest');
    if (hasLike) table.dropColumn('max_likes_per_guest');
  });
};
