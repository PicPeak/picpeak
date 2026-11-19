'use strict';
/**
 * Migration 368: who viewed and downloaded what (issue 2503).
 *
 *   access_logs.guest_id                         the registered guest
 *                                                (gallery_guests.id) behind a
 *                                                view or download, when the
 *                                                gallery asks guests for their
 *                                                identity before downloading.
 *                                                NULL everywhere else, which
 *                                                every existing row gets.
 *   event_feedback_settings.require_guest_for_download
 *                                                per gallery, off by default:
 *                                                in guest identity mode a
 *                                                download asks for the guest's
 *                                                name first.
 *   event_feedback_settings.guest_privacy_text   optional short text shown in
 *                                                the guest prompt (why name and
 *                                                email are collected).
 *
 * guest_id carries no foreign key. Guests are soft-deleted (is_deleted), so an
 * ON DELETE rule would never fire; erasing a guest clears the column
 * explicitly (feedbackService.anonymizeGuestFeedback). And adding a
 * foreign-key column through knex makes SQLite rebuild access_logs, one of
 * the largest tables, for a constraint it would not enforce.
 *
 * Additive and nullable; the index serves the per-guest counts of the admin
 * guests list.
 */
exports.up = async function up(knex) {
  if (await knex.schema.hasTable('access_logs') && !(await knex.schema.hasColumn('access_logs', 'guest_id'))) {
    await knex.schema.alterTable('access_logs', (table) => {
      table.integer('guest_id').nullable();
    });
  }
  // Outside the column guard: a run that died between the two statements
  // must still get its index on the re-run.
  if (await knex.schema.hasTable('access_logs')) {
    await knex.raw('CREATE INDEX IF NOT EXISTS access_logs_event_guest_idx ON access_logs (event_id, guest_id)');
  }

  if (await knex.schema.hasTable('event_feedback_settings')) {
    if (!(await knex.schema.hasColumn('event_feedback_settings', 'require_guest_for_download'))) {
      await knex.schema.alterTable('event_feedback_settings', (table) => {
        table.boolean('require_guest_for_download').defaultTo(false);
      });
    }
    if (!(await knex.schema.hasColumn('event_feedback_settings', 'guest_privacy_text'))) {
      await knex.schema.alterTable('event_feedback_settings', (table) => {
        table.text('guest_privacy_text').nullable();
      });
    }
  }
};

exports.down = async function down(knex) {
  if (await knex.schema.hasTable('event_feedback_settings')) {
    for (const column of ['guest_privacy_text', 'require_guest_for_download']) {
      if (await knex.schema.hasColumn('event_feedback_settings', column)) {
        await knex.schema.alterTable('event_feedback_settings', (table) => {
          table.dropColumn(column);
        });
      }
    }
  }
  // Before the column: SQLite rebuilds the table on dropColumn, and a
  // lingering index over the dropped column makes the rebuild fail.
  await knex.raw('DROP INDEX IF EXISTS access_logs_event_guest_idx');
  if (await knex.schema.hasTable('access_logs') && await knex.schema.hasColumn('access_logs', 'guest_id')) {
    await knex.schema.alterTable('access_logs', (table) => {
      table.dropColumn('guest_id');
    });
  }
};
