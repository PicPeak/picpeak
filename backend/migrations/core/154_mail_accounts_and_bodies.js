/**
 * Messages Phase 2 — additional inbound mailboxes + captured message bodies.
 *
 * `mail_accounts` holds inbound mailboxes BEYOND the primary accounting IMAP
 * that already lives in `email_configs` (e.g. the customer `hello@` mailbox).
 * The intake poller (emailIntakeService) polls the accounting mailbox AND every
 * enabled row here; customer mail is logged with its body but not routed to the
 * accounting inbox.
 *
 * The new `received_emails` columns capture the parsed message so the Messages
 * reading pane can show it: `account_key` tags which mailbox it came from,
 * `body_html`/`body_text` hold the (server-sanitized) body, `to_address` the
 * envelope recipient. All additive + guarded.
 */
exports.up = async function up(knex) {
  const hasAccounts = await knex.schema.hasTable('mail_accounts');
  if (!hasAccounts) {
    await knex.schema.createTable('mail_accounts', (t) => {
      t.increments('id').primary();
      t.string('account_key', 64).notNullable().unique(); // e.g. 'customers'
      t.string('label', 120);
      t.string('imap_host', 255);
      t.integer('imap_port').defaultTo(993);
      t.boolean('imap_secure').defaultTo(true);
      t.string('imap_user', 255);
      t.string('imap_pass', 512);
      t.string('imap_folder', 255).defaultTo('INBOX');
      t.boolean('enabled').defaultTo(false);
      t.timestamp('created_at').defaultTo(knex.fn.now());
      t.timestamp('updated_at').defaultTo(knex.fn.now());
    });
  }

  const cols = [
    ['account_key', (t) => t.string('account_key', 64)],
    ['to_address', (t) => t.string('to_address', 512)],
    ['body_html', (t) => t.text('body_html')],
    ['body_text', (t) => t.text('body_text')],
  ];
  for (const [name, add] of cols) {
    // eslint-disable-next-line no-await-in-loop
    const has = await knex.schema.hasColumn('received_emails', name);
    // eslint-disable-next-line no-await-in-loop
    if (!has) await knex.schema.alterTable('received_emails', add);
  }
};

exports.down = async function down(knex) {
  // Non-destructive on the audit log: leave the added columns in place (they're
  // nullable and harmless). Only drop the new table.
  await knex.schema.dropTableIfExists('mail_accounts');
};
