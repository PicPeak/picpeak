/**
 * Finish selection / approve edited photos (issue 1733, A1).
 *
 * A guest hands their picks over ("selection"), and later signs off the
 * edited photos ("approval"). One row per hand-over, per guest:
 *
 * - selection_submissions.guest_id / guest_identifier: the same pair
 *   photo_feedback carries. guest_id for a registered guest, and always the
 *   identifier (the guest's own, or the anonymous browser identity), so a
 *   submission is found by the rule that finds the viewer's feedback.
 * - kind: 'selection' locks that guest's likes and favourites, 'approval'
 *   locks their per-photo approve / reject (services/selectionSubmissions.js).
 * - reopened_at / reopened_by: an admin reopened it. A row with reopened_at
 *   NULL is the active one, and the partial unique index allows exactly one
 *   active row per (event, guest, kind); reopened rows stay as history.
 * - item_count: how many picks (or approved photos) the guest handed over.
 *
 * event_feedback_settings.allow_selection_submit: per-gallery switch for the
 * "Finish selection" button. Defaults FALSE for the reason migration 270
 * gives for allow_decisions: a new button appearing unannounced in live
 * galleries would be a visible change, and every guest of a party gallery
 * could send the photographer a notification.
 *
 * SQLite runs without FK cascades, so the event delete removes these rows
 * explicitly (routes/adminEvents/helpers.js).
 */

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('selection_submissions'))
    && await knex.schema.hasTable('events')) {
    const hasGuests = await knex.schema.hasTable('gallery_guests');
    const hasAdmins = await knex.schema.hasTable('admin_users');
    await knex.schema.createTable('selection_submissions', (t) => {
      t.increments('id').primary();
      t.integer('event_id').unsigned().notNullable()
        .references('id').inTable('events').onDelete('CASCADE');
      const guestId = t.integer('guest_id').nullable();
      if (hasGuests) guestId.references('id').inTable('gallery_guests').onDelete('SET NULL');
      t.string('guest_identifier', 64).notNullable();
      t.string('guest_name', 255).nullable();
      t.string('kind', 16).notNullable();
      t.integer('item_count').notNullable().defaultTo(0);
      t.text('note').nullable();
      t.timestamp('submitted_at').notNullable();
      t.timestamp('reopened_at').nullable();
      const reopenedBy = t.integer('reopened_by').unsigned().nullable();
      if (hasAdmins) reopenedBy.references('id').inTable('admin_users').onDelete('SET NULL');
      // The admin list, and the merge, read by event and by guest.
      t.index(['event_id', 'kind']);
      t.index(['guest_id']);
    });
  }

  // Outside the table guard: a run that died between the two statements must
  // not leave the one-active-submission rule missing for good.
  if (await knex.schema.hasTable('selection_submissions')) {
    await knex.raw(
      'CREATE UNIQUE INDEX IF NOT EXISTS selection_submissions_active_idx '
      + 'ON selection_submissions (event_id, guest_identifier, kind) WHERE reopened_at IS NULL'
    );
  }

  if (await knex.schema.hasTable('event_feedback_settings')
    && !(await knex.schema.hasColumn('event_feedback_settings', 'allow_selection_submit'))) {
    await knex.schema.alterTable('event_feedback_settings', (t) => {
      t.boolean('allow_selection_submit').defaultTo(false);
    });
  }
};

exports.down = async function down(knex) {
  if (await knex.schema.hasTable('event_feedback_settings')
    && await knex.schema.hasColumn('event_feedback_settings', 'allow_selection_submit')) {
    await knex.schema.alterTable('event_feedback_settings', (t) => {
      t.dropColumn('allow_selection_submit');
    });
  }
  await knex.raw('DROP INDEX IF EXISTS selection_submissions_active_idx');
  await knex.schema.dropTableIfExists('selection_submissions');
};
