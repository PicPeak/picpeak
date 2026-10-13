/**
 * Drawn annotations on a photo comment (issue 1733, item A2; see issue 744).
 *
 * - photo_feedback.annotation: nullable JSON text on a feedback_type='comment'
 *   row. The drawing belongs to the comment, so moderation, hiding and
 *   show_feedback_to_guests apply to it exactly as they do to the text. Only
 *   ever written re-serialised from utils/photoAnnotation.js, never the
 *   client's raw string.
 * - event_feedback_settings.allow_annotations: per-event toggle, default FALSE
 *   for the reason migration 270 gives for allow_decisions — a new control
 *   must not appear unannounced in galleries that are already live.
 */

exports.up = async function (knex) {
  if (!(await knex.schema.hasColumn('event_feedback_settings', 'allow_annotations'))) {
    await knex.schema.alterTable('event_feedback_settings', (table) => {
      table.boolean('allow_annotations').defaultTo(false);
    });
  }

  if (!(await knex.schema.hasColumn('photo_feedback', 'annotation'))) {
    await knex.schema.alterTable('photo_feedback', (table) => {
      table.text('annotation');
    });
  }
};

exports.down = async function (knex) {
  if (await knex.schema.hasColumn('photo_feedback', 'annotation')) {
    await knex.schema.alterTable('photo_feedback', (table) => {
      table.dropColumn('annotation');
    });
  }
  if (await knex.schema.hasColumn('event_feedback_settings', 'allow_annotations')) {
    await knex.schema.alterTable('event_feedback_settings', (table) => {
      table.dropColumn('allow_annotations');
    });
  }
};
