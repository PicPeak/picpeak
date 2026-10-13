/**
 * Migration 293: who asked to be mailed when a download job is ready
 * (issue 1733).
 *
 * A side table rather than a column on `download_jobs`, because a job is
 * shared: a second requester of the same archive joins the first one's build,
 * and each of them may want the mail. One row per job and address, so nobody
 * is mailed twice for one archive; `notified_at` is the claim that makes the
 * send happen once when two replicas see the job turn ready.
 *
 * The address is never typed by the requester. It is copied from the guest
 * identity (verified address) or the customer account behind the session at
 * the moment they ask. `guest_id` / `customer_account_id` name that owner:
 * removing a guest or erasing a customer deletes their rows, and a mail only
 * goes out while the owner still holds the address.
 *
 * Rows go with their job (ON DELETE CASCADE, and the sweep deletes them
 * explicitly for SQLite files opened without foreign keys).
 */

const OWNERS = { guest_id: 'gallery_guests', customer_account_id: 'customer_accounts' };

const ownerColumn = (table, column) => table.integer(column).unsigned()
  .references('id').inTable(OWNERS[column]).onDelete('CASCADE');

exports.up = async function up(knex) {
  if (await knex.schema.hasTable('download_job_recipients')) {
    // A database that ran this migration before the owner columns were added.
    for (const column of Object.keys(OWNERS)) {
      if (!(await knex.schema.hasColumn('download_job_recipients', column))) {
        await knex.schema.alterTable('download_job_recipients', (table) => ownerColumn(table, column));
      }
    }
    return;
  }
  await knex.schema.createTable('download_job_recipients', (table) => {
    table.increments('id').primary();
    table.integer('job_id').unsigned().notNullable()
      .references('id').inTable('download_jobs').onDelete('CASCADE');
    table.string('email', 255).notNullable();
    for (const column of Object.keys(OWNERS)) ownerColumn(table, column);
    table.timestamp('created_at').notNullable();
    table.timestamp('notified_at');
    table.unique(['job_id', 'email'], { indexName: 'download_job_recipients_job_email_uq' });
    // The hourly cap counts an address's recent requests.
    table.index(['email', 'created_at'], 'download_job_recipients_email_idx');
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('download_job_recipients');
};
