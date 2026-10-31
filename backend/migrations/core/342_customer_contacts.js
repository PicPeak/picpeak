/**
 * Migration 342: customer contacts.
 *
 * A customer account is one company with one account holder. The holder stays
 * on customer_accounts and nothing about them changes; this table holds the
 * additional people, each with an own login and own rights, so a company no
 * longer has to share one password.
 *
 *   customer_contacts       One person at one customer. A right is 'none',
 *                           'view' or 'act' (customerContactsService.RIGHTS)
 *                           and defaults to 'none', so a contact starts with
 *                           no access. The same address may be a contact at
 *                           several customers, with rights of its own at each.
 *   customer_logins         The password of a person who is not an account
 *                           holder, keyed by address, so a person at several
 *                           customers has one login. A holder's password stays
 *                           on customer_accounts and also opens the customers
 *                           where that address is a contact.
 *
 * customer_invitations and customer_password_resets gain a nullable contact_id:
 * a contact's link goes through the same hardened token tables as a holder's.
 * The foreign key exists on PostgreSQL only: on SQLite knex would rebuild each
 * table to add it, which silently drops the write guards migration 273 put on
 * them. SQLite does not enforce foreign keys here anyway, so the service
 * deletes these rows itself (customerContactsService) on both engines.
 *
 * No backfill, on purpose. A restored archive that predates this table leaves
 * it empty, and migrations do not run again after a restore; a table every
 * customer depended on would lock them all out at that point.
 *
 * Every step is guarded and safe to re-run.
 */

const isPg = (knex) => knex.client.config.client === 'pg';

exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('customer_contacts'))) {
    const hasAdmins = await knex.schema.hasTable('admin_users');
    await knex.schema.createTable('customer_contacts', (t) => {
      t.increments('id').primary();
      t.integer('customer_account_id').unsigned().notNullable()
        .references('id').inTable('customer_accounts').onDelete('CASCADE');
      t.string('email', 255).notNullable();

      t.string('salutation', 32);
      t.string('first_name', 80);
      t.string('last_name', 80);
      t.string('display_name', 120);
      t.string('phone', 40);
      t.string('preferred_language', 8);

      // Bumped to end this contact's sessions at this customer only.
      t.timestamp('password_changed_at');
      t.timestamp('last_login');
      t.string('last_login_ip', 45);
      t.boolean('is_active').notNullable().defaultTo(true);
      t.boolean('receives_mail').notNullable().defaultTo(true);

      t.string('right_galleries', 8).notNullable().defaultTo('none');
      t.string('right_quotes', 8).notNullable().defaultTo('none');
      t.string('right_contracts', 8).notNullable().defaultTo('none');
      t.string('right_bills', 8).notNullable().defaultTo('none');
      t.string('right_documents', 8).notNullable().defaultTo('none');
      t.string('right_company', 8).notNullable().defaultTo('none');

      if (hasAdmins) {
        t.integer('created_by_admin_id').unsigned()
          .references('id').inTable('admin_users').onDelete('SET NULL');
      } else {
        t.integer('created_by_admin_id').unsigned();
      }
      t.timestamp('created_at').defaultTo(knex.fn.now());
      t.timestamp('updated_at').defaultTo(knex.fn.now());

      t.unique(['customer_account_id', 'email']);
      t.index(['email']);
    });
  }

  if (!(await knex.schema.hasTable('customer_logins'))) {
    await knex.schema.createTable('customer_logins', (t) => {
      t.increments('id').primary();
      t.string('email', 255).notNullable().unique();
      t.string('password_hash', 255).notNullable();
      t.timestamp('password_changed_at');
      t.timestamp('created_at').defaultTo(knex.fn.now());
      t.timestamp('updated_at').defaultTo(knex.fn.now());
    });
  }

  for (const table of ['customer_invitations', 'customer_password_resets']) {
    if ((await knex.schema.hasTable(table)) && !(await knex.schema.hasColumn(table, 'contact_id'))) {
      await knex.schema.alterTable(table, (t) => {
        const column = t.integer('contact_id').unsigned();
        if (isPg(knex)) column.references('id').inTable('customer_contacts').onDelete('CASCADE');
        t.index(['contact_id']);
      });
    }
  }
};

exports.down = async function (knex) {
  for (const table of ['customer_password_resets', 'customer_invitations']) {
    if (await knex.schema.hasColumn(table, 'contact_id')) {
      await knex.schema.alterTable(table, (t) => {
        t.dropIndex(['contact_id']);
        if (isPg(knex)) t.dropForeign(['contact_id']);
        t.dropColumn('contact_id');
      });
    }
  }
  // Dropping a column rebuilds the table on SQLite, and the guards with it.
  if (!isPg(knex)) {
    const { installAccountRecoveryWriteGuards } = require('../../src/services/accountRecoveryStorageHardening');
    await installAccountRecoveryWriteGuards(knex);
  }
  await knex.schema.dropTableIfExists('customer_logins');
  await knex.schema.dropTableIfExists('customer_contacts');
};
