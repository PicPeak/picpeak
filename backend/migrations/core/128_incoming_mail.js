/**
 * Migration 128: incoming mail (IMAP) support.
 *
 * - email_configs gains imap_* columns (a second config block alongside the
 *   outgoing smtp_* one; single row, same field shape).
 * - `incomingMail` feature flag (default OFF, standalone).
 * - received_emails: an audit log of messages the IMAP poller processed
 *   (dedupe key = message_id), mirroring the outgoing email_queue / "Sent
 *   emails" surface with a "Received emails" one.
 */
async function addColumn(knex, table, column, builder) {
  if (!(await knex.schema.hasColumn(table, column))) {
    await knex.schema.alterTable(table, builder);
  }
}

exports.up = async function (knex) {
  if (await knex.schema.hasTable('email_configs')) {
    await addColumn(knex, 'email_configs', 'imap_host', (t) => t.string('imap_host', 255));
    await addColumn(knex, 'email_configs', 'imap_port', (t) => t.integer('imap_port'));
    await addColumn(knex, 'email_configs', 'imap_secure', (t) => t.boolean('imap_secure').notNullable().defaultTo(true));
    await addColumn(knex, 'email_configs', 'imap_user', (t) => t.string('imap_user', 255));
    await addColumn(knex, 'email_configs', 'imap_pass', (t) => t.string('imap_pass', 512));
    await addColumn(knex, 'email_configs', 'imap_folder', (t) => t.string('imap_folder', 128).defaultTo('INBOX'));
  }

  if (await knex.schema.hasTable('feature_flags')) {
    const existing = await knex('feature_flags').where({ key: 'incomingMail' }).first();
    if (!existing) await knex('feature_flags').insert({ key: 'incomingMail', value: false });
  }

  if (!(await knex.schema.hasTable('received_emails'))) {
    await knex.schema.createTable('received_emails', (table) => {
      table.increments('id').primary();
      table.string('message_id', 512);
      table.string('from_address', 512);
      table.text('subject');
      table.timestamp('received_at');
      table.integer('attachment_count').notNullable().defaultTo(0);
      // ingested | no_attachment | duplicate | error
      table.string('status', 24).notNullable().defaultTo('ingested');
      table.integer('inbound_document_id').unsigned();
      table.text('error');
      table.timestamp('created_at').defaultTo(knex.fn.now());
      // UNIQUE (not just INDEX): message_id is the dedup/claim key for the IMAP
      // poller. The in-process `polling` lock serialises within one backend, but a
      // second replica / rolling-deploy overlap would otherwise let two workers
      // both pass the check-then-insert and double-ingest the same mail. NULLs stay
      // distinct (Postgres + SQLite) so no-Message-ID rows aren't blocked. The
      // intake claims this row BEFORE ingesting.
      table.unique(['message_id']);
      table.index(['status']);
    });
  }
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('received_emails');
  if (await knex.schema.hasTable('feature_flags')) {
    await knex('feature_flags').where({ key: 'incomingMail' }).del();
  }
  if (await knex.schema.hasTable('email_configs')) {
    for (const col of ['imap_host', 'imap_port', 'imap_secure', 'imap_user', 'imap_pass', 'imap_folder']) {
      if (await knex.schema.hasColumn('email_configs', col)) {
        // eslint-disable-next-line no-await-in-loop
        await knex.schema.alterTable('email_configs', (t) => t.dropColumn(col));
      }
    }
  }
};
