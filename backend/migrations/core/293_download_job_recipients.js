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
 * the moment they ask.
 *
 * Rows go with their job (ON DELETE CASCADE, and the sweep deletes them
 * explicitly for SQLite files opened without foreign keys).
 */

exports.up = async function up(knex) {
  if (await knex.schema.hasTable('download_job_recipients')) return;
  await knex.schema.createTable('download_job_recipients', (table) => {
    table.increments('id').primary();
    table.integer('job_id').unsigned().notNullable()
      .references('id').inTable('download_jobs').onDelete('CASCADE');
    table.string('email', 255).notNullable();
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
