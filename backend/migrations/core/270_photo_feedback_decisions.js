/**
 * Approve / reject per photo for client proofing (issue 744).
 *
 * Same shape as colour labels (migration 182): ONE value per guest per photo,
 * changeable, the same value again toggles it off, drawn from a fixed set
 * (constants/photoDecisions.js). No new table.
 *
 * - event_feedback_settings.allow_decisions: per-event toggle. Defaults FALSE
 *   for the reason 182 gives for allow_color_labels — approve / reject buttons
 *   appearing unannounced in galleries mid-proofing would be a visible change
 *   to live galleries. New events inherit the global
 *   `event_default_allow_decisions` via services/feedbackDefaults.js.
 * - photo_feedback.decision: 'approved' | 'rejected' for
 *   feedback_type='decision' rows. The optional reason rides in the row's
 *   existing comment_text column rather than a column of its own.
 * - photos.approved_count / photos.rejected_count: denormalized totals,
 *   maintained by updatePhotoFeedbackStats beside color_label_count. The admin
 *   approved / rejected / undecided filter reads these.
 * - photo_feedback_decision_idx: per-decision reads over
 *   (event_id, feedback_type, decision), like photo_feedback_color_label_idx.
 */

exports.up = async function (knex) {
  const hasAllowDecisions = await knex.schema.hasColumn('event_feedback_settings', 'allow_decisions');
  if (!hasAllowDecisions) {
    await knex.schema.alterTable('event_feedback_settings', (table) => {
      table.boolean('allow_decisions').defaultTo(false);
    });
  }

  const hasDecision = await knex.schema.hasColumn('photo_feedback', 'decision');
  if (!hasDecision) {
    await knex.schema.alterTable('photo_feedback', (table) => {
      table.string('decision', 16);
    });
  }

  // Outside the column guard, for the reason migration 182 gives: a run that
  // died between the two statements must not leave the index missing for good.
  await knex.raw(
    'CREATE INDEX IF NOT EXISTS photo_feedback_decision_idx '
    + 'ON photo_feedback (event_id, feedback_type, decision)'
  );

  for (const column of ['approved_count', 'rejected_count']) {
    if (!(await knex.schema.hasColumn('photos', column))) {
      await knex.schema.alterTable('photos', (table) => {
        table.integer(column).defaultTo(0);
      });
    }
  }
};

exports.down = async function (knex) {
  for (const column of ['rejected_count', 'approved_count']) {
    if (await knex.schema.hasColumn('photos', column)) {
      await knex.schema.alterTable('photos', (table) => {
        table.dropColumn(column);
      });
    }
  }
  // Before the column, unconditionally: SQLite rebuilds the table on
  // dropColumn and a lingering index over the dropped column fails it.
  await knex.raw('DROP INDEX IF EXISTS photo_feedback_decision_idx');
  if (await knex.schema.hasColumn('photo_feedback', 'decision')) {
    await knex.schema.alterTable('photo_feedback', (table) => {
      table.dropColumn('decision');
    });
  }
  if (await knex.schema.hasColumn('event_feedback_settings', 'allow_decisions')) {
    await knex.schema.alterTable('event_feedback_settings', (table) => {
      table.dropColumn('allow_decisions');
    });
  }
};
