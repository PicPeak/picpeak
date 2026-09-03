/**
 * `business_profile.email_signature_enabled` + `email_signature_extra` —
 * the global email footer signature (issue #1264).
 *
 * The business profile already carries the full issuer block (address,
 * phone, email, website, VAT id) but none of it ever reached an email:
 * those columns only feed the quote/invoice PDF renderer and the public
 * quote page. Every outgoing mail footer was the fixed logo + company
 * name + copyright line built inside `wrapEmailHtml`.
 *
 * Rather than copy the address into a second place, the wrapper now reads
 * this profile row. These two columns are the only new state: a master
 * toggle and one free-text line for the legal notice (Handelsregister /
 * registration number / disclaimer) that has no dedicated column.
 *
 * Default FALSE on purpose: an upgraded install keeps a byte-identical
 * footer until an admin turns the signature on.
 */

exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('business_profile'))) return;

  if (!(await knex.schema.hasColumn('business_profile', 'email_signature_enabled'))) {
    await knex.schema.alterTable('business_profile', (table) => {
      table.boolean('email_signature_enabled').notNullable().defaultTo(false);
    });
  }
  if (!(await knex.schema.hasColumn('business_profile', 'email_signature_extra'))) {
    await knex.schema.alterTable('business_profile', (table) => {
      // Plain text, rendered escaped and <br>-separated. Not HTML.
      table.text('email_signature_extra');
    });
  }
};

exports.down = async function (knex) {
  if (!(await knex.schema.hasTable('business_profile'))) return;

  for (const column of ['email_signature_enabled', 'email_signature_extra']) {
    if (await knex.schema.hasColumn('business_profile', column)) {
      await knex.schema.alterTable('business_profile', (table) => {
        table.dropColumn(column);
      });
    }
  }
};
