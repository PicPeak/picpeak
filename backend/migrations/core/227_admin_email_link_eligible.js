/**
 * `admin_users.email_link_eligible` — whether a single-sign-on login may link
 * to this admin by email.
 *
 * The first SSO login of an IdP user that has no binding yet is matched to an
 * unlinked local admin by email (oidcService.resolveAdminFromClaims). That
 * match is only as trustworthy as the local email. An admin can change their
 * own email from the profile page without proving they own the new address,
 * and a users.edit holder can change other admins' emails, so a changed email
 * must not be enough to take over an IdP identity on its first login.
 *
 * TRUE means the email was set by a trusted flow: the setup wizard, invite
 * acceptance, the installer/CLI, or a super_admin. Editing an email through
 * the profile page, or by an admin who is not super_admin, sets it FALSE.
 *
 * Existing rows default to TRUE so linking keeps working on upgrade — the
 * column is read through formatBoolean() so SQLite's 0/1 and Postgres'
 * true/false both work.
 */

exports.up = async function (knex) {
  if (!(await knex.schema.hasColumn('admin_users', 'email_link_eligible'))) {
    await knex.schema.alterTable('admin_users', (table) => {
      table.boolean('email_link_eligible').notNullable().defaultTo(true);
    });
    console.log('227: added admin_users.email_link_eligible');
  }
};

exports.down = async function (knex) {
  if (await knex.schema.hasColumn('admin_users', 'email_link_eligible')) {
    await knex.schema.alterTable('admin_users', (table) => {
      table.dropColumn('email_link_eligible');
    });
  }
};
