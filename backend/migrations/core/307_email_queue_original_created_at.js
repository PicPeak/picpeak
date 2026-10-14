/**
 * When the mail a resent copy repeats was queued (follow-up to
 * the customer erasure windows of migration 219).
 *
 * A resend queues a new row at the time of the resend. Customer erasure
 * attributes mail to an address by when it was queued, so a copy of an old
 * mail, resent after the address changed hands, counted as the new
 * holder's and stayed out of the original holder's erasure. The copy keeps
 * the original's queue time here; NULL on every row that is not a copy.
 */
exports.up = async function up(knex) {
  const has = await knex.schema.hasColumn('email_queue', 'original_created_at');
  if (!has) {
    await knex.schema.alterTable('email_queue', (t) => {
      t.timestamp('original_created_at').nullable();
    });
  }
};

exports.down = async function down(knex) {
  const has = await knex.schema.hasColumn('email_queue', 'original_created_at');
  if (has) {
    await knex.schema.alterTable('email_queue', (t) => {
      t.dropColumn('original_created_at');
    });
  }
};
