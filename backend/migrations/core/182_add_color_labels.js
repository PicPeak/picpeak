/**
 * Colour labels for client proofing (#1044).
 *
 * Structurally identical to emoji reactions (migration 164): ONE value per
 * guest per photo, changeable, the same value again toggles it off, drawn
 * from a fixed curated set (constants/colorLabels.js). No new table.
 *
 * - event_feedback_settings.allow_color_labels: per-event toggle next to
 *   allow_reactions. Defaults FALSE, unlike its siblings — a colour bar
 *   appearing unannounced in every gallery that already has feedback enabled
 *   would be a visible change to live galleries mid-proofing, so this one is
 *   opt-in. New events inherit the global `event_default_allow_color_labels`
 *   via services/feedbackDefaults.js.
 * - event_feedback_settings.keybind_mode: which lightbox shortcut scheme the
 *   gallery uses — 'colors' (1/2/3 = green/yellow/red, simplest for clients)
 *   or 'lightroom' (1-5 stars, 6-9 colours, identical muscle memory for
 *   photographers). See constants/colorLabels.js for the maps.
 * - photo_feedback.color_label: the colour for feedback_type='color_label'
 *   rows, validated against COLOR_LABELS.
 * - photos.color_label_count: denormalized total, maintained by
 *   updatePhotoFeedbackStats alongside like_count / reaction_count.
 * - photo_feedback_color_label_idx: the admin "show only the greens" filter
 *   runs as a whereExists over (event_id, feedback_type, color_label).
 */

exports.up = async function (knex) {
  const hasAllowColorLabels = await knex.schema.hasColumn('event_feedback_settings', 'allow_color_labels');
  if (!hasAllowColorLabels) {
    await knex.schema.alterTable('event_feedback_settings', (table) => {
      table.boolean('allow_color_labels').defaultTo(false);
    });
  }

  const hasKeybindMode = await knex.schema.hasColumn('event_feedback_settings', 'keybind_mode');
  if (!hasKeybindMode) {
    await knex.schema.alterTable('event_feedback_settings', (table) => {
      table.string('keybind_mode', 16).defaultTo('colors');
    });
  }

  const hasColorLabel = await knex.schema.hasColumn('photo_feedback', 'color_label');
  if (!hasColorLabel) {
    await knex.schema.alterTable('photo_feedback', (table) => {
      // Lightroom's colour names, lowercase: red/yellow/green/blue/purple.
      table.string('color_label', 16);
    });
  }

  // Outside the column guard on purpose: a run that died between the two
  // statements would otherwise leave the column present and the index missing,
  // and a re-run would skip both — silently costing the admin colour filter
  // the index this migration's header says it relies on. IF NOT EXISTS is
  // supported by Postgres and by SQLite (verified idempotent on 3.44), so this
  // is safe to re-run in any state.
  await knex.raw(
    'CREATE INDEX IF NOT EXISTS photo_feedback_color_label_idx '
    + 'ON photo_feedback (event_id, feedback_type, color_label)'
  );

  const hasColorLabelCount = await knex.schema.hasColumn('photos', 'color_label_count');
  if (!hasColorLabelCount) {
    await knex.schema.alterTable('photos', (table) => {
      table.integer('color_label_count').defaultTo(0);
    });
  }
};

exports.down = async function (knex) {
  if (await knex.schema.hasColumn('photos', 'color_label_count')) {
    await knex.schema.alterTable('photos', (table) => {
      table.dropColumn('color_label_count');
    });
  }
  // Drop the index first, and unconditionally: SQLite rebuilds the table on
  // dropColumn and a lingering index over the dropped column makes that
  // rebuild fail. Unconditional so a down() after a partial up() still clears
  // whichever half landed.
  await knex.raw('DROP INDEX IF EXISTS photo_feedback_color_label_idx');
  if (await knex.schema.hasColumn('photo_feedback', 'color_label')) {
    await knex.schema.alterTable('photo_feedback', (table) => {
      table.dropColumn('color_label');
    });
  }
  if (await knex.schema.hasColumn('event_feedback_settings', 'keybind_mode')) {
    await knex.schema.alterTable('event_feedback_settings', (table) => {
      table.dropColumn('keybind_mode');
    });
  }
  if (await knex.schema.hasColumn('event_feedback_settings', 'allow_color_labels')) {
    await knex.schema.alterTable('event_feedback_settings', (table) => {
      table.dropColumn('allow_color_labels');
    });
  }
};
