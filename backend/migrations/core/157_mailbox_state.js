/**
 * Messages — Archive / Delete (trash) support.
 *
 * `mailbox_state` on both mail tables: 'active' (normal folders), 'archived'
 * (Archived folder), or 'deleted' (Deleted/trash folder). Delete is soft — the
 * row moves to 'deleted' and is only removed for good when purged FROM the
 * Deleted folder. Legacy rows have NULL, treated as 'active'. Additive/guarded.
 */
exports.up = async function up(knex) {
  for (const table of ['email_queue', 'received_emails']) {
    // eslint-disable-next-line no-await-in-loop
    const has = await knex.schema.hasColumn(table, 'mailbox_state');
    // eslint-disable-next-line no-await-in-loop
    if (!has) {
      // eslint-disable-next-line no-await-in-loop
      await knex.schema.alterTable(table, (t) => {
        t.string('mailbox_state', 16).defaultTo('active');
      });
    }
  }
};

exports.down = async function down(knex) {
  for (const table of ['email_queue', 'received_emails']) {
    // eslint-disable-next-line no-await-in-loop
    const has = await knex.schema.hasColumn(table, 'mailbox_state');
    // eslint-disable-next-line no-await-in-loop
    if (has) {
      // eslint-disable-next-line no-await-in-loop
      await knex.schema.alterTable(table, (t) => { t.dropColumn('mailbox_state'); });
    }
  }
};
