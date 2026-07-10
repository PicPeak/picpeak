/**
 * Messages Phase 3 follow-up — outgoing (SMTP) settings per mail account.
 *
 * The customer mailbox (hello@) needs BOTH incoming (IMAP, migration 154) and
 * outgoing (SMTP) config, so replies to customers send from hello@ instead of
 * the global no-reply@ identity. All additive/guarded.
 */
exports.up = async function up(knex) {
  const cols = [
    ['smtp_host', (t) => t.string('smtp_host', 255)],
    ['smtp_port', (t) => t.integer('smtp_port')],
    ['smtp_secure', (t) => t.boolean('smtp_secure').defaultTo(false)],
    ['smtp_user', (t) => t.string('smtp_user', 255)],
    ['smtp_pass', (t) => t.string('smtp_pass', 512)],
    ['from_email', (t) => t.string('from_email', 255)],
    ['from_name', (t) => t.string('from_name', 120)],
  ];
  for (const [name, add] of cols) {
    // eslint-disable-next-line no-await-in-loop
    const has = await knex.schema.hasColumn('mail_accounts', name);
    // eslint-disable-next-line no-await-in-loop
    if (!has) await knex.schema.alterTable('mail_accounts', add);
  }
};

exports.down = async function down(knex) {
  const cols = ['smtp_host', 'smtp_port', 'smtp_secure', 'smtp_user', 'smtp_pass', 'from_email', 'from_name'];
  for (const name of cols) {
    // eslint-disable-next-line no-await-in-loop
    const has = await knex.schema.hasColumn('mail_accounts', name);
    // eslint-disable-next-line no-await-in-loop
    if (has) await knex.schema.alterTable('mail_accounts', (t) => t.dropColumn(name));
  }
};
