/**
 * Migration: store the rendered email HTML at send time.
 *
 * The Project Overview cockpit previews the ACTUAL email that was sent (not a
 * re-render from the current template, which may have changed). email_queue
 * only stored the template variables (email_data), so add a rendered_html
 * column the sender populates with the final wrapped HTML on dispatch.
 *
 * Nullable: rows queued/sent before this column existed have no stored HTML —
 * the cockpit reconstructs those from email_data with a "reconstructed" note.
 *
 * Idempotent: column guarded by hasColumn.
 */

exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('email_queue'))) return;
  if (!(await knex.schema.hasColumn('email_queue', 'rendered_html'))) {
    await knex.schema.alterTable('email_queue', (table) => {
      table.text('rendered_html');
    });
  }
};

exports.down = async function (knex) {
  if (!(await knex.schema.hasTable('email_queue'))) return;
  if (await knex.schema.hasColumn('email_queue', 'rendered_html')) {
    await knex.schema.alterTable('email_queue', (table) => {
      table.dropColumn('rendered_html');
    });
  }
};
