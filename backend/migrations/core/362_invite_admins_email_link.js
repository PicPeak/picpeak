'use strict';
/**
 * Migration 362: invitation-created admins need a confirmed email before a
 * first single-sign-on login may link to them by email.
 *
 * Since this release, accepting an invitation sets
 * `admin_users.email_link_eligible` to false (userManagementService): the
 * inviter chose the address, so accepting does not show that the account's
 * holder owns it. Accounts that accepted an invitation earlier kept the
 * column default from migration 227 (true). This applies the same rule to
 * them once: every admin that accepted an invitation (`invite_accepted_at`
 * set) and has no linked single-sign-on identity yet (`external_subject`
 * empty, migration 162) becomes not eligible. A Super Admin confirms the
 * address with "Confirm email for SSO" on the Users page to make it eligible
 * again. Accounts that already have a linked identity sign in through that
 * binding and are left as they are.
 *
 * Skipped on a schema without any of the columns it reads or writes.
 */

const COLUMNS = ['email_link_eligible', 'invite_accepted_at', 'external_subject'];

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('admin_users'))) return;
  for (const column of COLUMNS) {
    // eslint-disable-next-line no-await-in-loop
    if (!(await knex.schema.hasColumn('admin_users', column))) return;
  }
  const changed = await knex('admin_users')
    .whereNotNull('invite_accepted_at')
    .where((q) => q.whereNull('external_subject').orWhere('external_subject', ''))
    .where('email_link_eligible', true)
    .update({ email_link_eligible: false });
  if (changed) console.log(`362: ${changed} invited admin account(s) need their email confirmed before SSO linking`);
};

// No-op: the earlier values are not recorded, so they cannot be restored.
exports.down = async function down() {};
